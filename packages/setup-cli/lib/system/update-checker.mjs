import process from "node:process";

import {
  patchUpdateCache,
  readUpdateCache,
  releaseUpdateLock,
} from "./update-cache.mjs";

const REMOTE_URL =
  "https://raw.githubusercontent.com/fw-ai/nexus-cli/main/packages/setup-cli/package.json";

async function main() {
  const home = process.env.HOME ?? "";
  if (!home) return;

  // Snapshot only for the "already know a version" failure short-circuit.
  // Successful writes always re-read via patchUpdateCache so a concurrent
  // decline's snooze fields are not dropped.
  const hadLatestAtStart = Boolean(readUpdateCache(home)?.latestVersion);
  const checkedAt = Date.now();

  try {
    const res = await fetch(REMOTE_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("fetch failed");
    const { version } = await res.json();
    if (!version) throw new Error("missing version");
    await patchUpdateCache(home, {
      checkedAt,
      latestVersion: version,
      // Clear sticky failure so the next spawn uses the 24h TTL again.
      fetchFailed: false,
    });
  } catch {
    if (!hadLatestAtStart && !readUpdateCache(home)?.latestVersion) {
      try {
        await patchUpdateCache(home, {
          checkedAt,
          latestVersion: null,
          fetchFailed: true,
        });
      } catch {
        // Silent — main CLI must never be affected.
      }
    }
    // Keep existing cache when we already know a version but fetch failed.
  } finally {
    releaseUpdateLock(home);
  }
}

main().catch(() => {});
