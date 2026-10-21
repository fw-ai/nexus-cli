import { warn as uiWarn } from "../ui.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import { promptYesNo } from "../auth/login/prompts.mjs";

/**
 * Shared "is the IDE GUI process running?" guard used by every harness that
 * writes to an on-disk store the IDE may also be writing (Cursor's state.vscdb,
 * VS Code's chatLanguageModels.json). Writes while the IDE is open can be
 * clobbered by its in-memory/WAL cache, so the harness refuses — with a
 * `--force` escape that downgrades to a stderr warning.
 *
 * Each harness supplies its own process-name matchers via {@link IdeProcessSpec}
 * and its own human-readable warning message. The harness-specific
 * `isXxxRunning`/`assertXxxStopped` wrappers live next to their harness code and
 * delegate here so the per-platform pgrep/tasklist logic has one source of truth.
 */

/**
 * @typedef {Object} IdeProcessSpec
 * @property {string} darwinPattern  `pgrep -f` ERE on macOS (app bundle path).
 * @property {string} linuxPattern   `pgrep -f` ERE on Linux (binary path/name).
 * @property {(cmdline: string) => boolean} [linuxCmdlineMatches] Optional filter
 *   applied to each Linux `pgrep -f` hit via `/proc/<pid>/cmdline`. Use this to
 *   ignore Electron helper processes that share the IDE binary but do not own
 *   the on-disk store (VS Code `--type=utility` children, etc.).
 * @property {string} windowsImage   Regex fragment for a whole `tasklist` image
 *   name, e.g. `Cursor\\.exe` or `Code(- Insiders)?\\.exe`. Matched anchored at
 *   the start of a line (tasklist lists the image name in column 0) so it isn't
 *   a substring match — `MyCode.exe` / `VSCode.exe` must not match `Code...exe`.
 */

/** Default poll cadence while waiting for an IDE quit. */
export const IDE_QUIT_POLL_MS = 750;
/** Give the user this long to quit before offering continue-anyway. */
export const IDE_QUIT_WAIT_MS = 90_000;

const ENTER_PROMPT = "Press Enter once it's quit: ";

/**
 * Platform-appropriate "how to quit the IDE" shortcut. Closing the window is
 * not enough — the IDE keeps an in-memory/WAL cache that overwrites the store
 * on a clean quit — so the instruction names the real quit path per OS.
 * @returns {string}
 */
function quitShortcut() {
  const platform = os.platform();
  if (platform === "win32") return "Alt+F4 / File > Exit";
  if (platform === "darwin") return "Cmd-Q / File > Quit";
  return "Ctrl-Q / File > Quit";
}

/**
 * The menu label for fully exiting the IDE (differs on Windows).
 * @returns {string}
 */
function fileQuitLabel() {
  return os.platform() === "win32" ? "File > Exit" : "File > Quit";
}

/**
 * Platform-aware "Quit <label> (<shortcut>)" phrase for prompts and warnings.
 * @param {string} label
 * @returns {string}
 */
export function quitInstruction(label) {
  return `Quit ${label} (${quitShortcut()})`;
}

/**
 * @param {string | number} pid
 * @returns {string}
 */
function readLinuxCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

/**
 * @param {string} pgrepOutput
 * @param {(cmdline: string) => boolean} cmdlineMatches
 * @returns {boolean}
 */
export function anyLinuxPgrepHitMatches(pgrepOutput, cmdlineMatches) {
  for (const pid of pgrepOutput.trim().split("\n")) {
    if (!pid) {
      continue;
    }
    const cmdline = readLinuxCmdline(pid);
    if (cmdline && cmdlineMatches(cmdline)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {IdeProcessSpec} spec
 * @returns {boolean} true if the IDE GUI process is currently running.
 */
export function isIdeRunning(spec) {
  const platform = os.platform();
  try {
    if (platform === "win32") {
      const r = spawnSync("tasklist", ["/NH"], { encoding: "utf8" });
      // Anchor at line start (tasklist puts the image name in column 0) and
      // require a word boundary after, so the pattern matches a whole image
      // name and not a substring (MyCode.exe / VSCode.exe vs Code.exe).
      const re = new RegExp(`^\\s*${spec.windowsImage}\\b`, "im");
      return r.status === 0 && re.test(r.stdout || "");
    }
    const pattern = platform === "darwin" ? spec.darwinPattern : spec.linuxPattern;
    const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout.trim()) {
      return false;
    }
    if (platform === "linux" && spec.linuxCmdlineMatches) {
      return anyLinuxPgrepHitMatches(r.stdout, spec.linuxCmdlineMatches);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw (or warn with `force`) if the IDE GUI process is running.
 * @param {IdeProcessSpec} spec
 * @param {string} runningMessage  the harness-specific "quit it first" message
 * @param {{ force?: boolean }} [opts]
 */
export function assertIdeStopped(spec, runningMessage, { force = false } = {}) {
  if (!isIdeRunning(spec)) {
    return;
  }
  if (force) {
    console.warn(uiWarn(runningMessage));
    return;
  }
  throw new Error(runningMessage);
}

/**
 * Wait for Enter, cancellable via AbortSignal so auto-poll can win the race.
 * @param {{
 *   stdin: NodeJS.ReadStream | { isTTY?: boolean },
 *   stdout: NodeJS.WriteStream | object,
 *   signal?: AbortSignal,
 *   promptText?: string,
 * }} options
 * @returns {Promise<void>}
 */
export function waitForEnterConfirm({
  stdin,
  stdout,
  signal,
  promptText = ENTER_PROMPT,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }

    const rl = createInterface({ input: stdin, output: stdout });
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      rl.close();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    rl.question(promptText, () => {
      cleanup();
      resolve();
    });
  });
}

/**
 * Wait for the IDE GUI process to stop before writing. Unlike the sync
 * `assertIdeStopped` (which throws if the IDE is running), this is interactive:
 * when the IDE is running and stdin is a TTY, it asks the user to quit, then
 * **both** auto-polls for exit **and** lets them press Enter to confirm.
 * After {@link IDE_QUIT_WAIT_MS}, it offers continue-anyway (same as `--force`)
 * instead of looping forever. nexus does not close or reopen the IDE —
 * the user does. Ctrl-C cancels the wait.
 *
 * `force` skips the wait (downgrades to a stderr warning, like `assertIdeStopped`).
 * Non-interactive (no TTY) throws `runningMessage`, matching the historical
 * behavior. Deps (`isRunning`, `stdin`, `sleep`, `now`, `confirm`, `prompt`,
 * `log`) are injectable so the logic is unit-testable without a real IDE.
 *
 * @param {IdeProcessSpec} spec
 * @param {string} runningMessage  used for the `--force` warning and the non-TTY error
 * @param {{
 *   force?: boolean,
 *   stdin?: { isTTY?: boolean },
 *   stdout?: object,
 *   isRunning?: () => boolean,
 *   log?: (msg: string) => void,
 *   label?: string,
 *   pollIntervalMs?: number,
 *   maxWaitMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   confirm?: typeof promptYesNo,
 *   prompt?: (opts: { signal: AbortSignal }) => Promise<void>,
 *   instruction?: string,
 *   stillRunningHint?: string,
 * }} [opts]
 */
export async function ensureIdeStopped(spec, runningMessage, {
  force = false,
  stdin = process.stdin,
  stdout = process.stdout,
  isRunning = () => isIdeRunning(spec),
  log = (msg) => console.log(msg),
  label = "the IDE",
  pollIntervalMs = IDE_QUIT_POLL_MS,
  maxWaitMs = IDE_QUIT_WAIT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  confirm = promptYesNo,
  prompt = ({ signal }) => waitForEnterConfirm({ stdin, stdout, signal }),
  // How to stop the process, and the reminder when it outlives Enter. A GUI
  // quits from its menu; a CLI session (Codex) is ended in its own terminal.
  instruction = quitInstruction(label),
  stillRunningHint = `Use ${fileQuitLabel()} (not just close the window)`,
} = {}) {
  if (!isRunning()) {
    return;
  }
  if (force) {
    console.warn(uiWarn(runningMessage));
    return;
  }
  if (!stdin.isTTY) {
    throw new Error(runningMessage);
  }

  log(`${label} is running. ${instruction}, then press Enter — or just wait, I'll detect the exit.`);
  log(`Ctrl-C cancels. Or re-run with --force to write while it's still open (not recommended).`);

  const deadline = now() + maxWaitMs;
  while (isRunning()) {
    if (now() >= deadline) {
      log(
        `${label} still appears to be running after ${Math.round(maxWaitMs / 1000)}s. `
        + `${stillRunningHint}.`,
      );
      const proceed = await confirm(
        `Continue anyway and write while ${label} is still open? (not recommended)`,
        { stdin, stdout, defaultYes: false },
      );
      // Re-check after the prompt: the user may have quit while answering.
      if (!isRunning()) {
        return;
      }
      if (proceed) {
        console.warn(uiWarn(runningMessage));
        return;
      }
      throw new Error(runningMessage);
    }

    const abort = new AbortController();
    const poll = (async () => {
      while (!abort.signal.aborted) {
        if (now() >= deadline) {
          return "timeout";
        }
        // eslint-disable-next-line no-await-in-loop -- intentional sequential poll
        await sleep(pollIntervalMs);
        if (abort.signal.aborted) {
          return "aborted";
        }
        if (!isRunning()) {
          return "quit";
        }
      }
      return "aborted";
    })();

    const enter = Promise.resolve()
      .then(() => prompt({ signal: abort.signal }))
      .then(() => "enter")
      .catch((error) => {
        if (error?.name === "AbortError") {
          return "aborted";
        }
        throw error;
      });

    // eslint-disable-next-line no-await-in-loop -- intentional sequential wait
    const winner = await Promise.race([poll, enter]);
    abort.abort();

    if (!isRunning() || winner === "quit") {
      return;
    }
    if (winner === "enter") {
      log(
        `${label} still appears to be running. ${stillRunningHint}, `
        + "then press Enter again — or wait for auto-detect.",
      );
    }
    // timeout → next loop iteration hits the deadline branch
  }
}
