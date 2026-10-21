/**
 * `nexus claude live`: Claude Code on the left, live usage meter on the
 * right. Viewer-only — never touches harness settings.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { shellQuote } from "../../cli/path.mjs";
import { resolveSetupCliDir } from "../../system/ensure-cli-deps.mjs";
import { BRAND } from "../../ui/palette.mjs";
import { accent, bold, muted, symbols } from "../../ui/style.mjs";
import { findClaudeSessionLog, snapshotLiveSessionLogs } from "./usage/report.mjs";

export const CLAUDE_LIVE_TMUX_SESSION = "fireconnect-claude-live";

/** Per-run snapshot — avoids races when multiple live splits overlap. */
export function liveSnapshotPath() {
  return path.join(os.tmpdir(), `fc-claude-live-${process.pid}.json`);
}

/** @param {string} [window] tmux window id when the layout lives in the caller's session */
function killLayoutArgs(window = "") {
  return window ? ["kill-window", "-t", window] : ["kill-session", "-t", CLAUDE_LIVE_TMUX_SESSION];
}

/** Tear down the live split: its window inside the caller's tmux, else the dedicated session. */
export function killLiveLayout(env = process.env) {
  try {
    execFileSync("tmux", killLayoutArgs(env.FC_LIVE_WINDOW), { stdio: "ignore", env });
  } catch {
    /* session may already be gone */
  }
}

const METER_WIDTH_PERCENT = 50;
const LIVE_SESSION_COLS = 240;
const LIVE_SESSION_ROWS = 55;
const SETUP_CLI_DIR = resolveSetupCliDir();
const FIRECONNECT_BIN = path.join(SETUP_CLI_DIR, "bin/nexus.mjs");
const USAGE_HELPER = path.join(SETUP_CLI_DIR, "bin/claude-live-usage.mjs");

/**
 * @param {{ execFile?: typeof execFileSync, spawn?: typeof spawnSync }} [deps]
 */
export function tmuxAvailable(deps = {}) {
  const spawn = deps.spawn ?? spawnSync;
  return spawn("tmux", ["-V"], { encoding: "utf8" }).status === 0;
}

/** @returns {string[]} */
export function tmuxInstallHintLines() {
  const lines = ["tmux is required for the split-pane layout. Install it with:"];
  if (commandAvailable("brew")) {
    lines.push("  brew install tmux");
  } else if (commandAvailable("apt-get")) {
    lines.push("  sudo apt-get install -y tmux");
  } else if (commandAvailable("dnf")) {
    lines.push("  sudo dnf install -y tmux");
  } else if (commandAvailable("pacman")) {
    lines.push("  sudo pacman -S tmux");
  } else {
    lines.push("  your platform's package manager (package: tmux)");
  }
  return lines;
}

function commandAvailable(name) {
  return spawnSync("which", [name], { encoding: "utf8", stdio: "ignore" }).status === 0;
}

/**
 * @param {string} session
 * @param {{ env?: NodeJS.ProcessEnv, execFile?: typeof execFileSync }} [deps]
 */
export function tmuxHasSession(session, deps = {}) {
  const execFile = deps.execFile ?? execFileSync;
  const env = deps.env ?? process.env;
  try {
    execFile("tmux", ["has-session", "-t", session], { stdio: "ignore", env });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the left pane's shell has a live Claude (or its node runtime)
 * descendant.
 *
 * `pane_current_command` is unreliable here: the left pane runs claude as a
 * child of a non-interactive `bash -lc` (no job control), so the pane often
 * reports "bash" even while claude is running. Walk the process tree instead.
 *
 * @param {typeof execFileSync} execFile
 * @param {NodeJS.ProcessEnv} env
 * @param {string} panePid root process id of the left pane
 * @returns {boolean | null} true/false when probed, null when the probe could not run
 */
function paneRunsClaude(execFile, env, panePid) {
  let ps;
  try {
    ps = execFile("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8", env });
  } catch {
    return null;
  }
  const childrenOf = new Map();
  const commOf = new Map();
  for (const line of String(ps).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const [, pid, ppid, comm] = match;
    commOf.set(pid, comm.trim().toLowerCase());
    if (!childrenOf.has(ppid)) {
      childrenOf.set(ppid, []);
    }
    childrenOf.get(ppid).push(pid);
  }
  const queue = [...(childrenOf.get(String(panePid)) ?? [])];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const base = (commOf.get(pid) ?? "").split("/").pop();
    if (base.includes("claude") || base === "node") {
      return true;
    }
    queue.push(...(childrenOf.get(pid) ?? []));
  }
  return false;
}

/**
 * @param {string} session
 * @param {{ env?: NodeJS.ProcessEnv, execFile?: typeof execFileSync }} [deps]
 */
export function isLiveSessionActive(session, deps = {}) {
  const execFile = deps.execFile ?? execFileSync;
  const env = deps.env ?? process.env;
  // Fail-safe: this gates a destructive kill+recreate. Only return false on a
  // CONFIRMED stale session (left pane gone, or a successful probe that finds no
  // claude). Any probe error means "unknown", so preserve the session.
  let output;
  try {
    output = execFile("tmux", [
      "list-panes", "-t", `${session}:`, "-F", "#{pane_at_left} #{pane_pid}",
    ], { encoding: "utf8", env }).trim();
  } catch {
    return true;
  }
  if (!output) {
    return true;
  }
  const panes = output.split("\n").map((line) => {
    const space = line.indexOf(" ");
    return {
      atLeft: line.slice(0, space),
      pid: line.slice(space + 1).trim(),
    };
  });
  if (panes.length < 2) {
    return false;
  }
  const left = panes.find((pane) => pane.atLeft === "1");
  if (!left?.pid) {
    return false;
  }
  const active = paneRunsClaude(execFile, env, left.pid);
  return active === null ? true : active;
}

function killLiveSession(execFile, env, window = "") {
  try {
    execFile("tmux", killLayoutArgs(window), { stdio: "ignore", env });
  } catch {
    /* session may already be gone */
  }
}

/**
 * Absolute path to the `claude` executable on the caller's PATH, falling back to
 * the bare name.
 *
 * The live pane runs `bash -lc`, whose login-shell PATH can resolve `claude` to
 * a different (e.g. older Homebrew) install than the shell that ran `nexus
 * claude live`. Pinning the absolute path keeps the pane on the same binary the
 * user invoked.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveClaudeBin(env = process.env) {
  const pathEnv = env.PATH ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not in this directory */
    }
  }
  return "claude";
}

/**
 * Left pane: run Claude Code, then tear down the whole tmux layout on exit.
 *
 * The session is always pinned so the meter knows exactly which log to watch:
 * `resume: true` runs `claude --resume <id>` (`claude live --session <id>`);
 * otherwise `claude --session-id <id>` pins a fresh session to the generated id.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [home]
 * @param {{ sessionId?: string, resume?: boolean, window?: string }} [session]
 * @param {string} [claudeBin] absolute claude path (bare "claude" to resolve via PATH)
 */
export function claudePaneCommand(env, home, { sessionId = "", resume = false, window = "" } = {}, claudeBin = "claude") {
  const quotedBin = shellQuote(claudeBin);
  const claude = env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_API_KEY
    ? `env -u ANTHROPIC_AUTH_TOKEN ${quotedBin}`
    : quotedBin;
  let sessionArg = "";
  if (sessionId) {
    sessionArg = resume
      ? ` --resume ${shellQuote(sessionId)}`
      : ` --session-id ${shellQuote(sessionId)}`;
  }
  const kill = `tmux ${killLayoutArgs(window).join(" ")} 2>/dev/null`;
  const homeExport = home ? `export HOME=${shellQuote(home)}; ` : "";
  // Run claude as a CHILD, not via exec: `exec` would replace the shell, wiping
  // the EXIT trap and skipping the trailing kill — so exiting Claude left the
  // cost-meter pane running. As a child, the shell resumes and tears the split
  // down on both normal exit (/exit) and the EXIT/INT/TERM trap.
  return `${homeExport}trap '${kill}' EXIT INT TERM; ${claude}${sessionArg}; ${kill}`;
}

function usagePaneCommand(home, snapshotPath, sessionId = "", window = "") {
  const lines = [
    `export HOME=${shellQuote(home)}`,
    `export FC_LIVE_SNAPSHOT=${shellQuote(snapshotPath)}`,
    `export FC_LIVE_SPLIT=1`,
    `export TERM=xterm-256color`,
  ];
  if (sessionId) {
    lines.push(`export FC_LIVE_SESSION=${shellQuote(sessionId)}`);
  }
  if (window) {
    lines.push(`export FC_LIVE_WINDOW=${shellQuote(window)}`);
  }
  lines.push(`exec ${shellQuote(process.execPath)} ${shellQuote(USAGE_HELPER)} ${shellQuote(FIRECONNECT_BIN)}`);
  return lines.join("; ");
}

function respawnPane(execFile, env, target, command) {
  execFile("tmux", [
    "respawn-pane", "-k", "-t", target,
    "bash", "-lc", `export TERM=xterm-256color; ${command}`,
  ], { env });
}

/**
 * Pane titles, borders, and mouse so the split reads as a product surface.
 *
 * @param {typeof execFileSync} execFile
 * @param {NodeJS.ProcessEnv} env
 * @param {string} target session with an empty window (fireconnect-claude-live:) or a window id (@3)
 * @param {boolean} [ownSession] false when the layout is a window in the caller's session
 */
export function configureLiveTmuxSession(execFile, env, target, ownSession = true) {
  // Brand purple (matches the meter accent) for the active pane chrome; a
  // visible muted gray for inactive panes so the divider shows up full instead
  // of the near-invisible colour238.
  const active = BRAND.purple;
  const inactive = "colour240";
  const borderFormat = `#{?pane_active,#[fg=${active},bold],#[fg=colour245]} #{pane_title}`;
  const opts = [
    ["set-option", "-t", target, "-w", "pane-border-status", "top"],
    ["set-option", "-t", target, "-w", "pane-border-format", borderFormat],
    ["set-option", "-t", target, "-w", "pane-active-border-style", `fg=${active}`],
    ["set-option", "-t", target, "-w", "pane-border-style", `fg=${inactive}`],
    // mouse is a session option and focus-events a server option, so skip them in the caller's session.
    ...(ownSession
      ? [
        ["set-option", "-t", target, "-w", "mouse", "on"],
        ["set-option", "-t", target, "-w", "focus-events", "on"],
      ]
      : []),
    ["select-pane", "-t", `${target}.{left}`, "-T", "Claude Code"],
    ["select-pane", "-t", `${target}.{right}`, "-T", "Live cost"],
    ["select-pane", "-t", `${target}.{left}`],
  ];
  for (const args of opts) {
    execFile("tmux", args, { env });
  }
}

/** @param {NodeJS.WriteStream} stdout */
export function printLiveStartupMessage(stdout) {
  const lines = [
    "",
    bold("Opening a live split for Claude Code"),
    "",
    `  ${symbols.pointer} ${accent("left", stdout)}  ${muted("Claude Code — chat as usual", stdout)}`,
    `  ${symbols.pointer} ${accent("right", stdout)} ${muted("live cost meter — updates as you chat", stdout)}`,
    "",
    muted("Tip: Ctrl+b then arrow keys switch panes · click a pane with the mouse", stdout),
    muted("Exit Claude (/exit) to close the layout.", stdout),
    "",
  ];
  stdout.write(`${lines.join("\n")}\n`);
}

/**
 * 3-2-1 lead-in before the split takes over the screen, so the startup message
 * is actually readable before Claude spawns.
 *
 * @param {NodeJS.WriteStream} stdout
 * @param {(ms: number) => Promise<void>} sleep
 */
export async function liveStartupCountdown(stdout, sleep) {
  for (const n of [3, 2, 1]) {
    stdout.write(`${accent(String(n), stdout)}${muted(" … ", stdout)}`);
    await sleep(1000);
  }
  stdout.write(`${muted("starting claude session with live cost tracker", stdout)}\n`);
}

/**
 * @param {{
 *   home: string,
 *   session?: string,
 *   env?: NodeJS.ProcessEnv,
 *   execFile?: typeof execFileSync,
 *   spawn?: typeof spawnSync,
 *   enterSession?: (opts: { env: NodeJS.ProcessEnv, execFile: typeof execFileSync }) => void,
 *   resolveSession?: typeof findClaudeSessionLog,
 *   resolveClaude?: (env: NodeJS.ProcessEnv) => string,
 *   newSessionId?: () => string,
 *   sleep?: (ms: number) => Promise<void>,
 *   stdout?: NodeJS.WriteStream,
 * }} opts
 */
export async function runClaudeLiveTmux({
  home,
  session = "",
  env = process.env,
  execFile = execFileSync,
  spawn = spawnSync,
  enterSession,
  resolveSession = findClaudeSessionLog,
  resolveClaude = resolveClaudeBin,
  newSessionId = randomUUID,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stdout = process.stdout,
} = {}) {
  if (!home) {
    throw new Error("HOME is required for `nexus claude live`.");
  }

  if (!tmuxAvailable({ spawn })) {
    throw new Error(tmuxInstallHintLines().join("\n"));
  }

  // Pin the session id so the meter locks onto exactly one log — never onto a
  // background session that happens to bump its mtime. `--session <id>` resumes
  // (resolve up front so an unknown id fails fast before any panes open);
  // otherwise generate an id for `claude --session-id`. Both panes share it.
  let sessionId;
  let resume = false;
  if (session) {
    const sessionPath = await resolveSession({ home, session });
    if (!sessionPath) {
      throw new Error(`No Claude Code session log matching '${session}'.`);
    }
    sessionId = path.basename(sessionPath, ".jsonl");
    resume = true;
  } else {
    sessionId = newSessionId();
  }

  // Inside tmux the layout opens as a window in the caller's session, so their client never leaves it.
  const inTmux = Boolean(env.TMUX);
  if (!inTmux && tmuxHasSession(CLAUDE_LIVE_TMUX_SESSION, { env, execFile })) {
    if (isLiveSessionActive(CLAUDE_LIVE_TMUX_SESSION, { env, execFile })) {
      if (!stdout.isTTY) {
        stdout.write(`'${CLAUDE_LIVE_TMUX_SESSION}' already running (detached)\n`);
        stdout.write(`  attach: tmux attach -t ${CLAUDE_LIVE_TMUX_SESSION}\n`);
        return;
      }
      stdout.write(`re-attaching to existing '${CLAUDE_LIVE_TMUX_SESSION}'\n`);
      (enterSession ?? defaultEnterSession)({ env, execFile, stdout });
      return;
    }
    killLiveSession(execFile, env);
  }

  // First run on a terminal: say what's about to happen and count down before
  // the split takes over the screen, so Claude only spawns after the 3-2-1.
  // The re-attach and detached paths returned above keep their own messages.
  if (stdout.isTTY) {
    printLiveStartupMessage(stdout);
    await liveStartupCountdown(stdout, sleep);
  }

  const snapshotPath = liveSnapshotPath();
  const snapshot = await snapshotLiveSessionLogs(home);
  await writeFile(snapshotPath, JSON.stringify(snapshot));

  // Window ids, an empty window, and {left}/{right} panes keep targets independent of base-index and pane-base-index.
  let target = `${CLAUDE_LIVE_TMUX_SESSION}:`;
  let window = "";
  try {
    if (inTmux) {
      window = String(execFile("tmux", [
        "new-window", "-P", "-F", "#{window_id}", "-n", "claude live",
      ], { encoding: "utf8", env })).trim();
      target = window;
    } else {
      execFile("tmux", [
        "new-session", "-d", "-s", CLAUDE_LIVE_TMUX_SESSION,
        "-x", String(LIVE_SESSION_COLS), "-y", String(LIVE_SESSION_ROWS),
      ], { env });
    }
    execFile("tmux", ["split-window", "-h", "-t", target, "-p", String(METER_WIDTH_PERCENT)], { env });
    // Resolve claude to the absolute binary the caller's PATH picks, so the
    // login-shell pane doesn't fall back to a stale install (e.g. Homebrew).
    const claudeBin = resolveClaude(env);
    respawnPane(execFile, env, `${target}.{right}`, usagePaneCommand(home, snapshotPath, sessionId, window));
    respawnPane(execFile, env, `${target}.{left}`, claudePaneCommand(env, home, { sessionId, resume, window }, claudeBin));
    configureLiveTmuxSession(execFile, env, target, !inTmux);
  } catch (error) {
    if (!inTmux || window) {
      killLiveSession(execFile, env, window);
    }
    throw error;
  }

  if (inTmux) {
    return;
  }

  if (!stdout.isTTY) {
    stdout.write(`started '${CLAUDE_LIVE_TMUX_SESSION}' (detached — no terminal for attach)\n`);
    stdout.write(`  attach: tmux attach -t ${CLAUDE_LIVE_TMUX_SESSION}\n`);
    stdout.write("  exit Claude (/exit) to close the layout\n");
    return;
  }

  (enterSession ?? defaultEnterSession)({ env, execFile, stdout });
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   execFile: typeof execFileSync,
 *   stdout: NodeJS.WriteStream,
 * }} opts
 */
function defaultEnterSession({ env, execFile }) {
  execFile("tmux", ["attach", "-t", CLAUDE_LIVE_TMUX_SESSION], { stdio: "inherit", env });
}
