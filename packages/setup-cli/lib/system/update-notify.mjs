import {
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { promptYesNo } from "../auth/login/prompts.mjs";
import { readLocalVersion } from "./version.mjs";
import {
  isGitInstall,
  isUpgradePromptSnoozed,
  patchUpdateCache,
  readUpdateCache,
  updateLockPath,
  versionIsNewer,
  waitForUpdateLock,
} from "./update-cache.mjs";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
/** How long to suppress the interactive upgrade prompt after the user declines. */
export const UPGRADE_PROMPT_SNOOZE_MS = 24 * 60 * 60 * 1000;

const UPGRADE_PROMPT = "Update now?";

const SKIP_UPDATE_CHECK_COMMANDS = new Set([
  "update",
  "upgrade",
  "uninstall",
  "version",
  "banner",
  "finalize-install",
]);

export { isUpgradePromptSnoozed } from "./update-cache.mjs";

export function shouldSpawnChecker(cache, now = Date.now()) {
  if (!cache) return true;

  const age = now - (cache.checkedAt ?? 0);
  if (cache.pending) {
    return age >= PENDING_TTL_MS;
  }
  if (cache.fetchFailed) {
    return age >= FAILURE_RETRY_MS;
  }
  if (cache.latestVersion) {
    return age >= CACHE_TTL_MS;
  }
  return age >= FAILURE_RETRY_MS;
}

/**
 * Prompt UI needs a fully interactive terminal: answers on stdin, and both
 * stdout and stderr as TTYs so piping (`nexus … | jq`) stays non-blocking.
 *
 * @param {{ isTTY?: boolean } | null | undefined} input
 * @param {{ isTTY?: boolean } | null | undefined} stdout
 * @param {{ isTTY?: boolean } | null | undefined} output
 */
export function isFullyInteractiveTerminal(input, stdout, output) {
  return Boolean(input?.isTTY && stdout?.isTTY && output?.isTTY);
}

/**
 * Whether to ask "Update now?" instead of only printing the tip.
 * Git installs only; requires a fully interactive terminal.
 *
 * @param {{
 *   isTTY?: boolean,
 *   isGitInstall?: boolean,
 *   cache?: Record<string, unknown> | null,
 *   latestVersion?: string,
 *   environment?: Record<string, string | undefined>,
 *   now?: number,
 * }} options
 */
export function shouldPromptUpgrade({
  isTTY = false,
  isGitInstall: gitInstall = false,
  cache = null,
  latestVersion = "",
  environment = process.env,
  now = Date.now(),
} = {}) {
  if (!isTTY || !gitInstall || !latestVersion) {
    return false;
  }
  if (environment.NEXUS_NO_UPDATE_PROMPT === "1") {
    return false;
  }
  return !isUpgradePromptSnoozed(cache, latestVersion, now);
}

function lockAgeMs(home, now = Date.now()) {
  try {
    return now - statSync(updateLockPath(home)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function hasActiveUpdateLock(home, now = Date.now()) {
  return lockAgeMs(home, now) < PENDING_TTL_MS;
}

export function tryAcquireUpdateLock(home, now = Date.now()) {
  const lockPath = updateLockPath(home);
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    if (hasActiveUpdateLock(home, now)) {
      return false;
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // No stale lock to remove.
    }
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    return false;
  }
}

function spawnChecker(home) {
  try {
    const workerPath = fileURLToPath(new URL("./update-checker.mjs", import.meta.url));
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: home },
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Never fail the main process for a background check.
  }
}

function printUpdateTip(localVersion, latestVersion, gitInstall) {
  const upgradeInstruction = gitInstall
    ? "Run: nexus update"
    : "Run: curl -fsSL https://nexus.fireworks.ai/install.sh | bash";
  process.stderr.write(
    `\nNexus update available: v${localVersion} → v${latestVersion}\n`
      + `${upgradeInstruction}\n\n`,
  );
}

/**
 * @param {{
 *   home: string,
 *   localVersion: string,
 *   latestVersion: string,
 *   prompt?: typeof promptYesNo,
 *   runUpgrade?: () => Promise<void>,
 *   input?: { isTTY?: boolean },
 *   output?: { isTTY?: boolean },
 * }} options
 */
export async function promptAndMaybeUpgrade({
  home,
  localVersion,
  latestVersion,
  prompt = promptYesNo,
  runUpgrade,
  input = process.stdin,
  output = process.stderr,
}) {
  process.stderr.write(
    `\nNexus update available: v${localVersion} → v${latestVersion}\n`,
  );

  let accepted;
  try {
    accepted = await prompt(UPGRADE_PROMPT, {
      stdin: input,
      stdout: output,
      defaultYes: true,
    });
  } catch (error) {
    const wrapped = new Error(error?.message || "Upgrade prompt failed");
    wrapped.code = "ERR_UPGRADE_PROMPT";
    wrapped.cause = error;
    throw wrapped;
  }

  if (!accepted) {
    try {
      // Wait out an in-flight checker so its write cannot race past this
      // patch and drop snooze. patchUpdateCache re-reads on disk so we also
      // keep any newer latestVersion the checker already committed.
      await waitForUpdateLock(home);
      await patchUpdateCache(home, {
        checkedAt: Date.now(),
        latestVersion,
        promptSnoozedUntil: Date.now() + UPGRADE_PROMPT_SNOOZE_MS,
        promptSnoozedVersion: latestVersion,
      });
    } catch {
      // Best-effort snooze — never fail the CLI over cache I/O.
    }
    process.stderr.write("Skipped.\n\n");
    return { upgraded: false, snoozed: true };
  }

  const upgrade = runUpgrade ?? (async () => {
    const { runUpgradeCommand } = await import("../cli/commands/global.mjs");
    await runUpgradeCommand({ home });
  });
  // Upgrade failures must propagate — do not swallow into a tip.
  await upgrade();
  return { upgraded: true, snoozed: false };
}

/**
 * Notify about available updates (tip or interactive prompt) and refresh the
 * background version cache when stale.
 *
 * @param {string} command
 * @param {string} [homeOverride]
 * @param {{
 *   prompt?: typeof promptYesNo,
 *   runUpgrade?: () => Promise<void>,
 *   input?: { isTTY?: boolean },
 *   output?: { isTTY?: boolean },
 *   stdout?: { isTTY?: boolean },
 *   environment?: Record<string, string | undefined>,
 *   now?: number,
 * }} [options]
 */
export async function checkForUpdates(command, homeOverride, options = {}) {
  // Never run under test: detached child races temp-dir cleanup and hits network.
  const environment = options.environment ?? process.env;
  if (environment.NEXUS_TEST === "1" || environment.NODE_ENV === "test") return;
  // Explicit opt-out for spawned CLI children that must strip NEXUS_TEST
  // (e.g. tests exercising the real file key backend) but still must not spawn
  // the detached checker into a throwaway HOME.
  if (environment.NEXUS_NO_UPDATE_CHECK === "1") return;
  if (SKIP_UPDATE_CHECK_COMMANDS.has(command)) return;

  const home = homeOverride || environment.HOME || "";
  if (!home) return;

  const localVersion = readLocalVersion();
  const cache = readUpdateCache(home);
  const latestVersion = typeof cache?.latestVersion === "string" ? cache.latestVersion : "";
  const gitInstall = isGitInstall(home);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const now = options.now ?? Date.now();

  if (localVersion && latestVersion && versionIsNewer(latestVersion, localVersion)) {
    const canPrompt = shouldPromptUpgrade({
      isTTY: isFullyInteractiveTerminal(input, stdout, output),
      isGitInstall: gitInstall,
      cache,
      latestVersion,
      environment,
      now,
    });

    if (canPrompt) {
      try {
        await promptAndMaybeUpgrade({
          home,
          localVersion,
          latestVersion,
          prompt: options.prompt,
          runUpgrade: options.runUpgrade,
          input,
          output,
        });
      } catch (error) {
        // Only fall back to the tip when the Yes/No prompt itself fails.
        if (error?.code === "ERR_UPGRADE_PROMPT") {
          printUpdateTip(localVersion, latestVersion, gitInstall);
        } else {
          throw error;
        }
      }
    } else if (!isUpgradePromptSnoozed(cache, latestVersion, now)) {
      printUpdateTip(localVersion, latestVersion, gitInstall);
    }
  }

  // Re-read cache: decline may have refreshed checkedAt + snooze fields.
  const cacheForSpawn = readUpdateCache(home) ?? cache;
  if (shouldSpawnChecker(cacheForSpawn, now) && tryAcquireUpdateLock(home, now)) {
    spawnChecker(home);
  }
}
