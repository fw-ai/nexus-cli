import {
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../io/atomic-write.mjs";
import { compareVersions } from "./release-notes.mjs";

export function updateCachePath(home) {
  return path.join(home, ".nexus", "update-check.json");
}

export function updateLockPath(home) {
  return path.join(home, ".nexus", "update-check.lock");
}

export function readUpdateCache(home) {
  try {
    return JSON.parse(readFileSync(updateCachePath(home), "utf8"));
  } catch {
    return null;
  }
}

export async function writeUpdateCache(home, payload) {
  const filePath = updateCachePath(home);
  mkdirSync(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(payload)}\n`);
}

/**
 * Merge a patch into the on-disk update cache.
 * Always re-reads so concurrent writers (decline vs background checker) keep
 * each other's fields instead of clobbering from a stale snapshot.
 *
 * @param {string} home
 * @param {Record<string, unknown>} payload
 */
export async function patchUpdateCache(home, payload) {
  await writeUpdateCache(home, mergeUpdateCache(readUpdateCache(home), payload));
}

/**
 * Fold `payload` into `existing`. Payload wins on conflicts, except
 * `latestVersion` never moves backward (checker/decline races).
 *
 * @param {Record<string, unknown> | null | undefined} existing
 * @param {Record<string, unknown>} payload
 */
export function mergeUpdateCache(existing, payload) {
  const base = existing && typeof existing === "object" ? existing : {};
  const next = { ...base, ...payload };
  if (
    typeof base.latestVersion === "string"
    && typeof next.latestVersion === "string"
    && versionIsNewer(base.latestVersion, next.latestVersion)
  ) {
    next.latestVersion = base.latestVersion;
  }
  return next;
}

/** @param {string} left @param {string} right */
export function versionIsNewer(left, right) {
  return compareVersions(left, right) > 0;
}

/**
 * True when the interactive upgrade prompt should stay quiet (user said no).
 * A newer latestVersion than the one they declined clears the snooze.
 *
 * @param {Record<string, unknown> | null | undefined} cache
 * @param {string} latestVersion
 * @param {number} [now]
 */
export function isUpgradePromptSnoozed(cache, latestVersion, now = Date.now()) {
  if (!cache || !latestVersion) {
    return false;
  }
  const until = Number(cache.promptSnoozedUntil ?? 0);
  if (!Number.isFinite(until) || until <= now) {
    return false;
  }
  const snoozedVersion = typeof cache.promptSnoozedVersion === "string"
    ? cache.promptSnoozedVersion
    : "";
  if (snoozedVersion && versionIsNewer(latestVersion, snoozedVersion)) {
    return false;
  }
  return true;
}

export function isGitInstall(home) {
  return existsSync(path.join(home, ".nexus", "cli", ".git"));
}

export function releaseUpdateLock(home) {
  try {
    unlinkSync(updateLockPath(home));
  } catch {
    // Lock may already be gone.
  }
}

/**
 * Wait until the background checker lock is gone (or timeout).
 * @param {string} home
 * @param {number} [timeoutMs]
 * @param {() => number} [now]
 */
export async function waitForUpdateLock(home, timeoutMs = 2000, now = Date.now) {
  const deadline = now() + timeoutMs;
  while (existsSync(updateLockPath(home)) && now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
