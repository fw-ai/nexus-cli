import { mkdtemp, mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldSpawnChecker,
  hasActiveUpdateLock,
  tryAcquireUpdateLock,
  shouldPromptUpgrade,
  isUpgradePromptSnoozed,
  promptAndMaybeUpgrade,
  checkForUpdates,
  UPGRADE_PROMPT_SNOOZE_MS,
} from "../../lib/system/update-notify.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIVE_MIN = 5 * 60 * 1000;

describe("shouldSpawnChecker", () => {
  const now = 1_700_000_000_000;

  it("spawns when cache is missing", () => {
    assert.equal(shouldSpawnChecker(null, now), true);
  });

  it("does not spawn while a pending check is in flight", () => {
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - FIVE_MIN + 1000, pending: true }, now),
      false,
    );
  });

  it("spawns after pending TTL expires", () => {
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - FIVE_MIN - 1000, pending: true }, now),
      true,
    );
  });

  it("uses 24h TTL when latestVersion is known", () => {
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - DAY + 1000, latestVersion: "0.3.0" }, now),
      false,
    );
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - DAY - 1000, latestVersion: "0.3.0" }, now),
      true,
    );
  });

  it("uses 1h retry when fetch failed without a known version", () => {
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - HOUR + 1000, latestVersion: null }, now),
      false,
    );
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - HOUR - 1000, latestVersion: null }, now),
      true,
    );
  });

  it("uses 1h retry when fetchFailed is set even with a known version", () => {
    assert.equal(
      shouldSpawnChecker(
        { checkedAt: now - HOUR + 1000, latestVersion: "0.3.0", fetchFailed: true },
        now,
      ),
      false,
    );
    assert.equal(
      shouldSpawnChecker(
        { checkedAt: now - HOUR - 1000, latestVersion: "0.3.0", fetchFailed: true },
        now,
      ),
      true,
    );
  });
});

describe("tryAcquireUpdateLock", () => {
  it("prevents concurrent workers without touching the version cache", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-update-notify-"));
    const cacheDir = path.join(home, ".nexus");
    await mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, "update-check.json");

    await writeFile(
      cachePath,
      JSON.stringify({ checkedAt: Date.now(), latestVersion: "0.3.0" }),
    );

    assert.equal(tryAcquireUpdateLock(home), true);
    assert.equal(hasActiveUpdateLock(home), true);
    assert.equal(tryAcquireUpdateLock(home), false);

    const saved = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(saved.latestVersion, "0.3.0");
    assert.equal(saved.pending, undefined);
  });

  it("allows a new worker after the lock TTL expires", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-update-notify-"));
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    assert.equal(tryAcquireUpdateLock(home), true);

    const lockPath = path.join(home, ".nexus", "update-check.lock");
    const stale = new Date(Date.now() - FIVE_MIN - 1000);
    await utimes(lockPath, stale, stale);

    assert.equal(hasActiveUpdateLock(home), false);
    assert.equal(tryAcquireUpdateLock(home), true);
  });
});

describe("shouldPromptUpgrade / snooze", () => {
  const now = 1_700_000_000_000;

  it("prompts only for TTY git installs that are not snoozed", () => {
    assert.equal(
      shouldPromptUpgrade({
        isTTY: true,
        isGitInstall: true,
        latestVersion: "0.9.2",
        cache: { latestVersion: "0.9.2" },
        now,
      }),
      true,
    );
    assert.equal(
      shouldPromptUpgrade({
        isTTY: false,
        isGitInstall: true,
        latestVersion: "0.9.2",
        now,
      }),
      false,
    );
    assert.equal(
      shouldPromptUpgrade({
        isTTY: true,
        isGitInstall: false,
        latestVersion: "0.9.2",
        now,
      }),
      false,
    );
  });

  it("honors NEXUS_NO_UPDATE_PROMPT=1", () => {
    assert.equal(
      shouldPromptUpgrade({
        isTTY: true,
        isGitInstall: true,
        latestVersion: "0.9.2",
        environment: { NEXUS_NO_UPDATE_PROMPT: "1" },
        now,
      }),
      false,
    );
  });

  it("snoozes for 24h on the same latest version, then asks again for a newer one", () => {
    const cache = {
      latestVersion: "0.9.2",
      promptSnoozedUntil: now + UPGRADE_PROMPT_SNOOZE_MS,
      promptSnoozedVersion: "0.9.2",
    };
    assert.equal(isUpgradePromptSnoozed(cache, "0.9.2", now), true);
    assert.equal(
      shouldPromptUpgrade({
        isTTY: true,
        isGitInstall: true,
        latestVersion: "0.9.2",
        cache,
        now,
      }),
      false,
    );
    assert.equal(isUpgradePromptSnoozed(cache, "0.9.3", now), false);
    assert.equal(
      shouldPromptUpgrade({
        isTTY: true,
        isGitInstall: true,
        latestVersion: "0.9.3",
        cache,
        now,
      }),
      true,
    );
  });
});

describe("promptAndMaybeUpgrade", () => {
  it("runs upgrade when the user accepts", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-upgrade-prompt-yes-"));
    let upgraded = false;
    const result = await promptAndMaybeUpgrade({
      home,
      localVersion: "0.9.1",
      latestVersion: "0.9.2",
      prompt: async () => true,
      runUpgrade: async () => {
        upgraded = true;
      },
    });
    assert.deepEqual(result, { upgraded: true, snoozed: false });
    assert.equal(upgraded, true);
  });

  it("snoozes for 24h when the user declines", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-upgrade-prompt-no-"));
    await mkdir(path.join(home, ".nexus"), { recursive: true });
    const before = Date.now();
    const result = await promptAndMaybeUpgrade({
      home,
      localVersion: "0.9.1",
      latestVersion: "0.9.2",
      prompt: async () => false,
      runUpgrade: async () => {
        throw new Error("must not upgrade");
      },
    });
    assert.deepEqual(result, { upgraded: false, snoozed: true });
    const saved = JSON.parse(
      await readFile(path.join(home, ".nexus/update-check.json"), "utf8"),
    );
    assert.equal(saved.latestVersion, "0.9.2");
    assert.equal(saved.promptSnoozedVersion, "0.9.2");
    assert.ok(saved.promptSnoozedUntil >= before + UPGRADE_PROMPT_SNOOZE_MS - 1000);
  });
});

describe("checkForUpdates prompt path", () => {
  it("prompts on TTY git installs and skips the tip while snoozed", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-check-updates-"));
    await mkdir(path.join(home, ".nexus/cli/.git"), { recursive: true });
    await writeFile(
      path.join(home, ".nexus/update-check.json"),
      JSON.stringify({
        checkedAt: Date.now(),
        // Newer than package.json (0.9.1) so the tip/prompt path triggers.
        latestVersion: "9.9.9",
      }),
    );

    let prompted = false;
    await checkForUpdates("help", home, {
      environment: { HOME: home },
      input: { isTTY: true },
      output: { isTTY: true },
      stdout: { isTTY: true },
      prompt: async () => {
        prompted = true;
        return false;
      },
      runUpgrade: async () => {
        throw new Error("must not upgrade");
      },
    });
    assert.equal(prompted, true);

    prompted = false;
    const stderrChunks = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };
    try {
      await checkForUpdates("help", home, {
        environment: { HOME: home },
        input: { isTTY: true },
        output: { isTTY: true },
        stdout: { isTTY: true },
        prompt: async () => {
          prompted = true;
          return false;
        },
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(prompted, false);
    assert.doesNotMatch(stderrChunks.join(""), /update available/);
  });

  it("does not prompt when stdout is piped even if stderr is a TTY", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-check-updates-pipe-"));
    await mkdir(path.join(home, ".nexus/cli/.git"), { recursive: true });
    await writeFile(
      path.join(home, ".nexus/update-check.json"),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: "9.9.9" }),
    );

    let prompted = false;
    const stderrChunks = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };
    try {
      await checkForUpdates("help", home, {
        environment: { HOME: home },
        input: { isTTY: true },
        output: { isTTY: true },
        stdout: { isTTY: false },
        prompt: async () => {
          prompted = true;
          return true;
        },
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(prompted, false);
    assert.match(stderrChunks.join(""), /update available/);
    assert.match(stderrChunks.join(""), /Run: nexus update/);
  });

  it("rethrows upgrade failures after the user accepts", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-check-updates-fail-"));
    await mkdir(path.join(home, ".nexus/cli/.git"), { recursive: true });
    await writeFile(
      path.join(home, ".nexus/update-check.json"),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: "9.9.9" }),
    );

    await assert.rejects(
      () => checkForUpdates("help", home, {
        environment: { HOME: home },
        input: { isTTY: true },
        output: { isTTY: true },
        stdout: { isTTY: true },
        prompt: async () => true,
        runUpgrade: async () => {
          throw new Error("Upgrade failed: network");
        },
      }),
      /Upgrade failed: network/,
    );
  });
});

describe("checkForUpdates spawn suppression", () => {
  it("never spawns the detached checker when NEXUS_NO_UPDATE_CHECK=1", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-check-suppressed-"));
    // No update-check.json → shouldSpawnChecker would be true and the spawn
    // path would acquire the lock before detaching the worker. If the guard
    // works, no lock file ever appears.
    await checkForUpdates("help", home, {
      environment: { HOME: home, NEXUS_NO_UPDATE_CHECK: "1" },
    });
    await assert.rejects(
      () => readFile(path.join(home, ".nexus/update-check.lock")),
      (error) => error.code === "ENOENT",
    );
  });
});

describe("mergeUpdateCache", () => {
  it("preserves an active prompt snooze across checker refreshes", async () => {
    const { mergeUpdateCache } = await import("../../lib/system/update-cache.mjs");
    const until = Date.now() + UPGRADE_PROMPT_SNOOZE_MS;
    const merged = mergeUpdateCache(
      {
        checkedAt: 1,
        latestVersion: "0.9.2",
        promptSnoozedUntil: until,
        promptSnoozedVersion: "0.9.2",
      },
      { checkedAt: Date.now(), latestVersion: "0.9.2" },
    );
    assert.equal(merged.latestVersion, "0.9.2");
    assert.equal(merged.promptSnoozedUntil, until);
    assert.equal(merged.promptSnoozedVersion, "0.9.2");
  });

  it("does not roll latestVersion backward when writers race", async () => {
    const { mergeUpdateCache } = await import("../../lib/system/update-cache.mjs");
    const merged = mergeUpdateCache(
      { checkedAt: 1, latestVersion: "0.9.3" },
      {
        checkedAt: Date.now(),
        latestVersion: "0.9.2",
        promptSnoozedUntil: Date.now() + UPGRADE_PROMPT_SNOOZE_MS,
        promptSnoozedVersion: "0.9.2",
      },
    );
    assert.equal(merged.latestVersion, "0.9.3");
    assert.equal(merged.promptSnoozedVersion, "0.9.2");
  });

  it("clears a sticky fetchFailed flag on a successful refresh", async () => {
    const { mergeUpdateCache } = await import("../../lib/system/update-cache.mjs");
    const merged = mergeUpdateCache(
      {
        checkedAt: 1,
        latestVersion: null,
        fetchFailed: true,
      },
      {
        checkedAt: Date.now(),
        latestVersion: "0.9.2",
        fetchFailed: false,
      },
    );
    assert.equal(merged.latestVersion, "0.9.2");
    assert.equal(merged.fetchFailed, false);
  });

  it("keeps a decline snooze when the checker re-reads before writing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-update-race-"));
    await mkdir(path.join(home, ".nexus"), { recursive: true });
    const {
      patchUpdateCache,
      readUpdateCache,
      writeUpdateCache,
    } = await import("../../lib/system/update-cache.mjs");

    // Simulate checker start snapshot (no snooze yet).
    await writeUpdateCache(home, { checkedAt: 1, latestVersion: "0.9.2" });

    // Decline lands while checker is still fetching.
    const until = Date.now() + UPGRADE_PROMPT_SNOOZE_MS;
    await patchUpdateCache(home, {
      checkedAt: Date.now(),
      latestVersion: "0.9.2",
      promptSnoozedUntil: until,
      promptSnoozedVersion: "0.9.2",
    });

    // Checker finishes: re-read + merge (patchUpdateCache), must keep snooze.
    await patchUpdateCache(home, { checkedAt: Date.now(), latestVersion: "0.9.3" });
    const saved = readUpdateCache(home);
    assert.equal(saved.latestVersion, "0.9.3");
    assert.equal(saved.promptSnoozedVersion, "0.9.2");
    assert.equal(saved.promptSnoozedUntil, until);
  });
});
