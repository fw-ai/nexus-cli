import assert from "node:assert/strict";
import { existsSync, renameSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import * as dataDirModule from "../../lib/system/data-dir.mjs";
import {
  dataDirMigrationNote,
  hasForeignDataDir,
  isNexusDataDir,
  migrateLegacyDataDir,
} from "../../lib/system/data-dir.mjs";
import { runFireconnect, withTempHome } from "../helpers.mjs";

const NEXUS_CONFIG = `${JSON.stringify({ harnesses: {} })}\n`;

describe("migrateLegacyDataDir", () => {
  it("moves ~/.fireconnect to ~/.nexus and leaves a link at the old path", async () => {
    await withTempHome("data-dir-move-", async (home) => {
      await mkdir(path.join(home, ".fireconnect/claude"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{\"apiKey\":\"ref\"}\n");

      assert.equal(migrateLegacyDataDir(home), "moved");
      assert.ok((await lstat(path.join(home, ".nexus"))).isDirectory());
      assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), "{\"apiKey\":\"ref\"}\n");
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
      assert.equal(await readFile(path.join(home, ".fireconnect/config.json"), "utf8"), "{\"apiKey\":\"ref\"}\n");
      assert.equal(dataDirMigrationNote("moved"), "Moved ~/.fireconnect to ~/.nexus.");
    });
  });

  it("is a no-op once migrated, and when nothing is installed", async () => {
    await withTempHome("data-dir-idempotent-", async (home) => {
      assert.equal(migrateLegacyDataDir(home), "none");
      await mkdir(path.join(home, ".fireconnect"));
      assert.equal(migrateLegacyDataDir(home), "moved");
      assert.equal(migrateLegacyDataDir(home), "none");
      assert.equal(dataDirMigrationNote("none"), "");
    });
  });

  it("links ~/.nexus to the old directory when the rename fails, then finishes later", async () => {
    await withTempHome("data-dir-deferred-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"));
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      const busy = () => {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      };

      assert.equal(migrateLegacyDataDir(home, { rename: busy }), "deferred");
      assert.equal(await readlink(path.join(home, ".nexus")), ".fireconnect");
      assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), "{}\n");
      assert.match(dataDirMigrationNote("deferred"), /links to it for now/);

      assert.equal(migrateLegacyDataDir(home), "moved");
      assert.ok((await lstat(path.join(home, ".nexus"))).isDirectory());
      assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), "{}\n");
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
    });
  });

  it("treats a move another process already finished as done", async () => {
    await withTempHome("data-dir-race-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"));
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      const lost = (from, to) => {
        renameSync(from, to);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      };

      assert.equal(migrateLegacyDataDir(home, { rename: lost }), "none");
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
      assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), "{}\n");
    });
  });

  it("reports a failure when neither the move nor the fallback link works", {
    skip: process.getuid?.() === 0 && "root ignores the read-only HOME",
  }, async () => {
    await withTempHome("data-dir-failed-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"));
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      const denied = () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      };

      await chmod(home, 0o555);
      try {
        assert.equal(migrateLegacyDataDir(home, { rename: denied }), "failed");
      } finally {
        await chmod(home, 0o755);
      }
      assert.match(dataDirMigrationNote("failed"), /run any `nexus` command to retry/);
    });
  });

  it("moves a symlinked ~/.fireconnect (dotfile manager) as a link", async () => {
    await withTempHome("data-dir-stow-", async (home) => {
      await mkdir(path.join(home, "dotfiles/fireconnect"), { recursive: true });
      await writeFile(path.join(home, "dotfiles/fireconnect/config.json"), "{}\n");
      await symlink(path.join(home, "dotfiles/fireconnect"), path.join(home, ".fireconnect"), "dir");

      assert.equal(migrateLegacyDataDir(home), "moved");
      assert.equal(await readlink(path.join(home, ".nexus")), path.join(home, "dotfiles/fireconnect"));
      assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), "{}\n");
      assert.equal(await readFile(path.join(home, ".fireconnect/config.json"), "utf8"), "{}\n");
      assert.equal(migrateLegacyDataDir(home), "none");
    });
  });

  it("fills an existing ~/.nexus of ours from the old directory and sets the clashes aside", async () => {
    await withTempHome("data-dir-set-aside-", async (home) => {
      await mkdir(path.join(home, ".fireconnect/cli/packages/setup-cli/bin"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/cli/packages/setup-cli/bin/nexus.mjs"), "");
      await mkdir(path.join(home, ".fireconnect/claude"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/claude/provider-backup.json"), "{}\n");
      await writeFile(path.join(home, ".fireconnect/config.json"), "{\"old\":true}\n");
      await mkdir(path.join(home, ".nexus"));
      await writeFile(path.join(home, ".nexus/config.json"), NEXUS_CONFIG);

      assert.equal(migrateLegacyDataDir(home), "set-aside");
      assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), NEXUS_CONFIG);
      assert.equal(await readFile(path.join(home, ".nexus/claude/provider-backup.json"), "utf8"), "{}\n");
      assert.ok(existsSync(path.join(home, ".fireconnect/cli/packages/setup-cli/bin/nexus.mjs")), "launchers still resolve");
      assert.deepEqual(await readdir(path.join(home, ".nexus-pre")), ["config.json"]);
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
      assert.match(dataDirMigrationNote("set-aside"), /the old copies are in ~\/\.nexus-pre\./);
      assert.equal(migrateLegacyDataDir(home), "none");
    });
  });

  it("moves everything into an existing ~/.nexus when nothing clashes", async () => {
    await withTempHome("data-dir-fill-", async (home) => {
      await mkdir(path.join(home, ".fireconnect/codex"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/key-storage.json"), "{}\n");
      await mkdir(path.join(home, ".nexus"));

      assert.equal(migrateLegacyDataDir(home), "moved");
      assert.deepEqual((await readdir(path.join(home, ".nexus"))).sort(), ["codex", "key-storage.json"]);
      assert.equal(existsSync(path.join(home, ".nexus-pre")), false);
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
    });
  });

  it("never touches a ~/.nexus that belongs to another program", async () => {
    await withTempHome("data-dir-foreign-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"));
      await writeFile(path.join(home, ".fireconnect/config.json"), NEXUS_CONFIG);
      await mkdir(path.join(home, ".nexus"));
      await writeFile(path.join(home, ".nexus/settings.ini"), "other=1\n");

      assert.equal(hasForeignDataDir(home), true);
      assert.equal(migrateLegacyDataDir(home), "foreign");
      assert.equal(hasForeignDataDir(home), true, "the peek does not change anything");
      assert.deepEqual(await readdir(path.join(home, ".nexus")), ["settings.ini"]);
      assert.ok((await lstat(path.join(home, ".fireconnect"))).isDirectory());

      const result = await runFireconnect(["status"], { HOME: home });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /~\/\.nexus belongs to another program/);
      assert.deepEqual(await readdir(path.join(home, ".nexus")), ["settings.ini"]);
    });
  });

  it("does not report a foreign directory once the rename can proceed", async () => {
    await withTempHome("data-dir-not-foreign-", async (home) => {
      assert.equal(hasForeignDataDir(home), false, "nothing installed");
      await mkdir(path.join(home, ".fireconnect"));
      assert.equal(hasForeignDataDir(home), false, "no ~/.nexus yet");
      await mkdir(path.join(home, ".nexus"));
      assert.equal(hasForeignDataDir(home), false, "an empty ~/.nexus is ours to fill");
    });
  });

  it("recognizes its own ~/.nexus by the files only Nexus writes", async () => {
    await withTempHome("data-dir-ours-", async (home) => {
      const dir = path.join(home, ".nexus");
      await mkdir(dir);
      assert.equal(isNexusDataDir(dir), true, "empty");
      await writeFile(path.join(dir, "config.json"), "{}\n");
      assert.equal(isNexusDataDir(dir), false, "someone else's config.json");
      await writeFile(path.join(dir, "config.json"), NEXUS_CONFIG);
      assert.equal(isNexusDataDir(dir), true, "our config shape");
      await rm(path.join(dir, "config.json"));
      await writeFile(path.join(dir, "key-storage.json"), "{}\n");
      assert.equal(isNexusDataDir(dir), true, "key storage");
    });
  });

  it("recognizes the cache and state files its own writers leave in a fresh ~/.nexus", async () => {
    await withTempHome("data-dir-owned-files-", async (home) => {
      const dir = path.join(home, ".nexus");
      await mkdir(dir);
      // Each name can be the whole directory when a writer runs before the
      // rename migration does: the catalog and price caches
      // refresh on ordinary commands, so either can create ~/.nexus first.
      // The names are pinned literally here, not read back from the export,
      // so dropping one from the lib list fails this test instead of
      // silently shrinking it; the fallback keeps the test runnable (and
      // failing) against code that predates the export.
      const ownedFilenames = [
        "key-storage.json",
        "secret-backend.json",
        "rename-complete",
        "rename-announced",
        "catalog-cache.json",
        "list-price-cache.json",
        "codex-stock-models.json",
        "update-check.json",
        "update-check.lock",
        "release-notes.json",
        "minted-key.json",
        "demo.json",
        ".api-key",
        ".secret-memory",
      ];
      assert.deepEqual(
        [...(dataDirModule.NEXUS_OWNED_FILENAMES ?? ownedFilenames)].filter((name) => !["cli", "claude-desktop", "statusline-refresh"].includes(name)),
        ownedFilenames,
      );
      for (const filename of ownedFilenames) {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir);
        await writeFile(path.join(dir, filename), "{}\n");
        assert.equal(isNexusDataDir(dir), true, `a lone ${filename} is ours`);
      }
      // Account-suffixed memory stores are ours too.
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
      await writeFile(path.join(dir, ".secret-memory-example-account"), "{}\n");
      assert.equal(isNexusDataDir(dir), true, "a suffixed .secret-memory file is ours");
      // Directories left by writers that never run the migration — the
      // installer checkout, the Claude Desktop shim, the status line
      // helper — count the same way.
      for (const dirname of ["cli", "claude-desktop", "statusline-refresh"]) {
        await rm(dir, { recursive: true, force: true });
        await mkdir(path.join(dir, dirname), { recursive: true });
        assert.equal(isNexusDataDir(dir), true, `a lone ${dirname}/ is ours`);
      }
      // A name no Nexus writer produces is still someone else's directory.
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
      await writeFile(path.join(dir, "settings.ini"), "other=1\n");
      assert.equal(isNexusDataDir(dir), false, "an unrecognized file stays foreign");
      // A generic owned name beside foreign files does not claim the dir:
      // another program's demo.json must not let Nexus merge into it (and
      // later delete it on uninstall). A distinctive name still does.
      await writeFile(path.join(dir, "demo.json"), "{}\n");
      assert.equal(isNexusDataDir(dir), false, "a generic name beside foreign files stays foreign");
      await writeFile(path.join(dir, "key-storage.json"), "{}\n");
      assert.equal(isNexusDataDir(dir), true, "a distinctive name claims the dir");
      // A harness-less config shape does not claim the dir on its own.
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
      await writeFile(path.join(dir, "config.json"), JSON.stringify({ harnesses: null }));
      await writeFile(path.join(dir, "settings.ini"), "other=1\n");
      assert.equal(isNexusDataDir(dir), false, "harnesses: null is not our config shape");
      await rm(path.join(dir, "settings.ini"));
      await writeFile(path.join(dir, "config.json"), "{oops");
      await writeFile(path.join(dir, "catalog-cache.json"), "{}\n");
      assert.equal(isNexusDataDir(dir), true, "a malformed config beside our cache does not poison the dir");
    });
  });

  it("migrates when the status line helper beat the rename to ~/.nexus", async () => {
    await withTempHome("data-dir-statusline-race-", async (home) => {
      // The status line helper runs under Claude Code, never through the
      // CLI entry that migrates, and claims its session marker under
      // ~/.nexus/statusline-refresh before any cache refresh succeeds.
      await mkdir(path.join(home, ".fireconnect"));
      await writeFile(path.join(home, ".fireconnect/config.json"), NEXUS_CONFIG);
      await mkdir(path.join(home, ".nexus/statusline-refresh"), { recursive: true });
      await writeFile(path.join(home, ".nexus/statusline-refresh/session.refreshed"), "{}\n");

      assert.equal(migrateLegacyDataDir(home), "moved");
      assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), NEXUS_CONFIG);
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
    });
  });

  it("migrates when the caches beat the rename to ~/.nexus instead of wedging the upgrade", async () => {
    await withTempHome("data-dir-cache-race-", async (home) => {
      // The observed machine's state: the only ~/.nexus contents were the
      // two caches an early 0.10.0 command wrote, and every later upgrade
      // failed with "belongs to another program".
      await mkdir(path.join(home, ".fireconnect"));
      await writeFile(path.join(home, ".fireconnect/config.json"), NEXUS_CONFIG);
      await mkdir(path.join(home, ".nexus"));
      await writeFile(path.join(home, ".nexus/catalog-cache.json"), "{}\n");
      await writeFile(path.join(home, ".nexus/list-price-cache.json"), "{}\n");

      assert.equal(migrateLegacyDataDir(home), "moved");
      assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), NEXUS_CONFIG);
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
      assert.equal(migrateLegacyDataDir(home), "none");
    });
  });

  it("finishes a rename whose earlier steps failed on the next command, then stops", async () => {
    await withTempHome("data-dir-rename-retry-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await symlink(".nexus", path.join(home, ".fireconnect"), "dir");
      await mkdir(path.join(home, ".config/opencode"), { recursive: true });
      const opencodePath = path.join(home, ".config/opencode/opencode.json");
      await writeFile(opencodePath, JSON.stringify({
        provider: { "fireworks-ai": { options: { headers: { "HTTP-Referer": "fireconnect/v0.9.9" } } } },
      }));

      await runFireconnect(["status"], { HOME: home });

      assert.doesNotMatch(await readFile(opencodePath, "utf8"), /fireconnect\/v/);
      assert.equal(await lstat(path.join(home, ".nexus/rename-complete")).then(() => true), true);
      const again = await runFireconnect(["status"], { HOME: home });
      assert.doesNotMatch(again.stderr, /identify as Nexus CLI/);
    });
  });

  it("finishes the command from ~/.nexus when started from inside the moved install", async () => {
    await withTempHome("data-dir-relaunch-", async (home) => {
      const pkg = fileURLToPath(new URL("../..", import.meta.url));
      const legacySetup = path.join(home, ".fireconnect/cli/packages/setup-cli");
      await mkdir(legacySetup, { recursive: true });
      for (const entry of ["bin", "lib", "package.json"]) {
        await cp(path.join(pkg, entry), path.join(legacySetup, entry), { recursive: true });
      }
      await symlink(path.join(pkg, "node_modules"), path.join(legacySetup, "node_modules"), "dir");
      const { version } = JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8"));

      const result = spawnSync(process.execPath, [path.join(legacySetup, "bin/fireconnect.mjs"), "--version"], {
        env: { ...process.env, HOME: home, NEXUS_TEST: "1" },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `v${version}`);
      assert.match(result.stderr, /Moved ~\/\.fireconnect to ~\/\.nexus\./);
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
    });
  });
});

describe("migrateLegacyDataDir under concurrency", () => {
  const RACE_WORKER = `
    const { workerData, parentPort } = require("node:worker_threads");
    import(workerData.module).then(({ migrateLegacyDataDir }) => {
      const gate = new Int32Array(workerData.gate);
      Atomics.add(gate, 0, 1);
      while (Atomics.load(gate, 0) < workerData.count) {}
      parentPort.postMessage(migrateLegacyDataDir(workerData.home));
    });
  `;

  async function race(home, count) {
    const { Worker } = await import("node:worker_threads");
    const gate = new SharedArrayBuffer(4);
    const module = new URL("../../lib/system/data-dir.mjs", import.meta.url).href;
    return Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
      const worker = new Worker(RACE_WORKER, { eval: true, workerData: { module, gate, count, home } });
      worker.once("message", resolve);
      worker.once("error", reject);
    })));
  }

  it("never loses data or reports a false problem when runs race", async () => {
    for (let i = 0; i < 15; i += 1) {
      await withTempHome("data-dir-race-move-", async (home) => {
        await mkdir(path.join(home, ".fireconnect/claude"), { recursive: true });
        await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
        const results = await race(home, 8);
        assert.deepEqual(results.filter((r) => r !== "none" && r !== "moved"), []);
        assert.equal(results.filter((r) => r === "moved").length, 1);
        assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), "{}\n");
        assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
        assert.deepEqual((await readdir(home)).filter((e) => /^\.fireconnect\./.test(e)), []);
      });
      await withTempHome("data-dir-race-set-aside-", async (home) => {
        await mkdir(path.join(home, ".nexus"));
        await writeFile(path.join(home, ".nexus/config.json"), NEXUS_CONFIG);
        await mkdir(path.join(home, ".fireconnect"));
        await writeFile(path.join(home, ".fireconnect/config.json"), "{\"old\":true}\n");
        const results = await race(home, 8);
        assert.deepEqual(results.filter((r) => r !== "none" && r !== "set-aside"), []);
        assert.equal(results.filter((r) => r === "set-aside").length, 1);
        assert.equal(await readFile(path.join(home, ".nexus/config.json"), "utf8"), NEXUS_CONFIG);
        assert.equal(await readFile(path.join(home, ".nexus-pre/config.json"), "utf8"), "{\"old\":true}\n");
        assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
        assert.deepEqual((await readdir(home)).filter((e) => /^\.nexus-pre-/.test(e)), []);
      });
    }
  });
});
