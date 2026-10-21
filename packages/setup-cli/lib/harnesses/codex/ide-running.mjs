import { spawnSync } from "node:child_process";
import os from "node:os";
import process from "node:process";

import { ensureIdeStopped, isIdeRunning, quitInstruction } from "../../io/ide-running.mjs";

/* -------------------------------------------------------------------------- */
/* Running-ChatGPT guard — the ChatGPT app shares ~/.codex/config.toml and the  */
/* fireworks-model-catalog.json that `codex on`/`off` writes, but it loads the  */
/* model catalog into memory at boot. Writing while it's open leaves its        */
/* dropdown stale (the "custom" provider with no Fireworks models to pick)      */
/* until the user quits & reopens, so we refuse — with a --force escape.         */
/* -------------------------------------------------------------------------- */

export const CHATGPT_PROCESS_SPEC = {
  darwinPattern: "ChatGPT.app/Contents/MacOS/ChatGPT",
  // The official ChatGPT app's Linux build ships the same Electron shell; the
  // binary casing varies by distribution, so match either. Ignore Electron
  // helper/GPU/utility children (`--type=…`); only the main process is named
  // bare. Mirrors the Cursor/VS Code Linux spec.
  linuxPattern: "[/](chatgpt|ChatGPT)([[:space:]]|$)",
  linuxCmdlineMatches: (cmdline) => !/\s--type=/.test(cmdline),
  windowsImage: "ChatGPT\\.exe",
};

export const CHATGPT_RUNNING_MESSAGE =
  `The ChatGPT app is running. ${quitInstruction("the ChatGPT app")} `
  + "so it reloads the Fireworks model catalog, then rerun. Or pass --force to write anyway (not recommended).";

/**
 * @returns {boolean} true if the ChatGPT app GUI process is running.
 */
export function isChatGptRunning() {
  return isIdeRunning(CHATGPT_PROCESS_SPEC);
}

/**
 * Wait for the ChatGPT app to be quit before writing config/catalog.
 * Interactive: when the app is running and stdin is a TTY, prints a "quit it"
 * message and re-prompts (waiting for Enter) until it's no longer running, then
 * returns so the caller's write proceeds. `force` skips the wait (warns
 * instead). Non-interactive throws `CHATGPT_RUNNING_MESSAGE`. nexus does
 * not close or reopen the app — the user does.
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureChatGptStopped({ force = false } = {}) {
  return ensureIdeStopped(CHATGPT_PROCESS_SPEC, CHATGPT_RUNNING_MESSAGE, { force, label: "the ChatGPT app" });
}

/* -------------------------------------------------------------------------- */
/* Running-Codex guard — every `codex` session on a machine is served by one    */
/* shared app-server daemon, which reads config.toml and the model catalog at   */
/* boot and never again. A new `codex` attaches to that daemon rather than      */
/* starting its own, so `on`/`off` written while any session is open takes      */
/* effect nowhere until the daemon exits. We refuse until every session is      */
/* closed, then stop the idle daemon so the next `codex` boots a fresh one.     */
/* -------------------------------------------------------------------------- */

// A Codex session is the `codex` executable itself (the npm/standalone launcher
// or the native binary it execs); the shared daemon is the same binary run as
// `codex app-server --managed-daemon`, plus its `app-server daemon` updater.
// Matched on the executable name, not a substring, so a script or path that
// merely contains "codex" (this repo, an editor) never does. Any other
// `codex app-server` is a private stdio backend owned by an editor extension
// or desktop app: not a session, and never ours to stop.
const CODEX_EXECUTABLE = "(^|/)codex(\\.exe)?$";
const CODEX_APP_SERVER = /^\s*app-server(\s|$)/;
const CODEX_MANAGED_DAEMON = /^\s*app-server\s+(daemon(\s|$)|(.*\s)?--managed-daemon(\s|$))/;

/**
 * Split a `ps -o pid=,args=` listing into the Codex sessions and the shared
 * app-server daemon processes.
 * @param {string} psOutput
 * @returns {{ sessions: number[], daemons: number[] }}
 */
function classifyCodexProcesses(psOutput) {
  const executable = new RegExp(CODEX_EXECUTABLE);
  const sessions = [];
  const daemons = [];
  for (const line of String(psOutput ?? "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)(.*)$/);
    if (!match) {
      continue;
    }
    const [, pid, command, rest] = match;
    if (!executable.test(command)) {
      continue;
    }
    if (CODEX_MANAGED_DAEMON.test(rest)) {
      daemons.push(Number(pid));
    } else if (!CODEX_APP_SERVER.test(rest)) {
      sessions.push(Number(pid));
    }
  }
  return { sessions, daemons };
}

/**
 * Keep only `uid pid args` lines owned by `uid`, as `pid args`: another user's
 * Codex neither shares our daemon nor can be signalled by us.
 * @param {string} psOutput
 * @param {number} uid
 * @returns {string}
 */
function ownProcessLines(psOutput, uid) {
  const own = [];
  for (const line of String(psOutput ?? "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match && Number(match[1]) === uid) {
      own.push(match[2]);
    }
  }
  return own.join("\n");
}

/**
 * @returns {{ sessions: number[], daemons: number[] }} running Codex processes,
 *   empty on Windows or when `ps` is unavailable.
 */
function listCodexProcesses() {
  // Never read (and so never signal) the developer's real Codex under test:
  // specs that drive `codex on`/`off` describe the processes they want here.
  if (process.env.NEXUS_TEST === "1") {
    return classifyCodexProcesses(process.env.NEXUS_TEST_CODEX_PS ?? "");
  }
  if (os.platform() === "win32") {
    return { sessions: [], daemons: [] };
  }
  try {
    // -ww: never truncate args, or `--managed-daemon` can fall off the end.
    const r = spawnSync("ps", ["-axww", "-o", "uid=,pid=,args="], { encoding: "utf8" });
    if (r.status !== 0) {
      return { sessions: [], daemons: [] };
    }
    const found = classifyCodexProcesses(ownProcessLines(r.stdout, process.getuid()));
    return {
      sessions: found.sessions.filter((pid) => pid !== process.pid),
      daemons: found.daemons,
    };
  } catch {
    return { sessions: [], daemons: [] };
  }
}

/** SIGTERM `pid`; a no-op under test, where the listed pids are made up. */
function signalCodexProcess(pid) {
  if (process.env.NEXUS_TEST === "1") {
    return;
  }
  process.kill(pid, "SIGTERM");
}

/** @returns {boolean} true while any `codex` CLI session is open. */
export function isCodexSessionRunning() {
  return listCodexProcesses().sessions.length > 0;
}

export const CODEX_SESSION_RUNNING_MESSAGE =
  "Codex is running. Every Codex session shares one background process that loads "
  + "config.toml and the model catalog when it starts, so the change would not take "
  + "effect until all of them exit. Close every Codex session (/quit, or Ctrl-C twice), "
  + "then rerun. Or pass --force to write anyway (not recommended).";

/**
 * Wait for every Codex CLI session to be closed before writing config/catalog,
 * then stop the now-idle app-server daemon so the next `codex` reads the new
 * config. Same interaction as {@link ensureChatGptStopped}: interactive waits
 * for the user, `force` warns and skips the wait, non-interactive throws. The
 * daemon is left alone whenever a session is still open (`force`, or
 * continue-anyway after the wait). nexus never ends a session — the
 * user does.
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureCodexSessionsClosed({ force = false } = {}) {
  await ensureIdeStopped(null, CODEX_SESSION_RUNNING_MESSAGE, {
    force,
    label: "Codex",
    instruction: "Close every Codex session (/quit, or Ctrl-C twice)",
    stillRunningHint: "Check other terminals and editor panes for an open Codex session",
    isRunning: isCodexSessionRunning,
  });
  // `--force` and the continue-anyway prompt both return with sessions still
  // attached to the daemon; stopping it then would cut them off.
  if (isCodexSessionRunning()) {
    return;
  }
  stopCodexDaemons();
}

const CODEX_DAEMON_STOP_TIMEOUT_MS = 10_000;

/**
 * `codex app-server daemon stop`, Codex's own way to stop its daemon.
 * @returns {boolean} true when Codex reports the daemon stopped or not running;
 *   false when the subcommand is missing (older Codex), fails, or times out.
 */
function stopDaemonViaCodex() {
  if (process.env.NEXUS_TEST === "1") {
    return false;
  }
  try {
    const r = spawnSync("codex", ["app-server", "daemon", "stop"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CODEX_DAEMON_STOP_TIMEOUT_MS,
    });
    if (r.error || r.status !== 0) {
      return false;
    }
    const line = String(r.stdout ?? "").trim().split("\n").reverse().find((l) => l.startsWith("{"));
    const status = line ? JSON.parse(line)?.status : undefined;
    return status === "stopped" || status === "notRunning";
  } catch {
    return false;
  }
}

/**
 * Stop the Codex app-server daemon. Only safe with no session open: the
 * daemon reloads nothing, so the next `codex` must boot a new one. Asks Codex
 * to stop it first, and SIGTERMs the listed daemon processes only when that
 * does not work.
 */
function stopCodexDaemons() {
  const { daemons } = listCodexProcesses();
  if (daemons.length === 0 || stopDaemonViaCodex()) {
    return;
  }
  for (const pid of daemons) {
    try {
      signalCodexProcess(pid);
    } catch {
      // Already gone, or not ours to signal: the next `codex` copes either way.
    }
  }
}

