import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

import { finalizeInstallOrUpgrade, refreshModelSources } from "../../lib/system/finalize-install.mjs";
import {
  readCatalogCache,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel, withTempHome } from "../helpers.mjs";

describe("finalizeInstallOrUpgrade", () => {
  it("ensures deps, reprobes storage, and reconciles (injectable)", async () => {
    await withTempHome("finalize-install-", async (home) => {
      const calls = [];
      const result = await finalizeInstallOrUpgrade({
        home,
        installDir: `${home}/.nexus/cli`,
        setupDir: "/nonexistent-setup-for-test",
        log: (...args) => calls.push(["log", ...args]),
        ensureDeps: (dir) => {
          calls.push(["ensureDeps", dir]);
          return true;
        },
        reprobe: async (h) => {
          calls.push(["reprobe", h]);
          return { migrated: true, backend: { backend: "keychain" } };
        },
        migrate: async (h) => {
          calls.push(["migrate", h]);
          return ["Enabled MCP tool search for Claude Code (ENABLE_TOOL_SEARCH) — restart Claude Code to pick it up."];
        },
        reconcile: async (h) => {
          calls.push(["reconcile", h]);
          return ["Rebaked Claude Code API key — restart Claude Code to pick it up."];
        },
        codexSignIn: async (h) => {
          calls.push(["codexSignIn", h]);
          return ["Switched Codex to its own sign-in."];
        },
        refreshCatalog: async (h) => {
          calls.push(["refreshCatalog", h]);
        },
        rename: async (h) => {
          calls.push(["rename", h]);
          return ["Moved ~/.fireconnect to ~/.nexus."];
        },
      });

      assert.equal(result.migrated, true);
      assert.deepEqual(result.notes, [
        "Moved ~/.fireconnect to ~/.nexus.",
        "Enabled MCP tool search for Claude Code (ENABLE_TOOL_SEARCH) — restart Claude Code to pick it up.",
        "Rebaked Claude Code API key — restart Claude Code to pick it up.",
        "Switched Codex to its own sign-in.",
      ]);
      // The rename runs before any network work: open harness sessions call
      // the paths it repoints. Codex's re-on runs after the rebake, so it
      // reuses a literal key.
      assert.deepEqual(
        calls.filter(([name]) => name !== "log").map(([name]) => name),
        ["rename", "reprobe", "refreshCatalog", "migrate", "reconcile", "codexSignIn"],
      );
      assert.ok(calls.some(([name, msg]) => name === "log" && /Moved Fireworks API key/.test(String(msg))));
      assert.ok(calls.some(([name, msg]) => name === "log" && /ENABLE_TOOL_SEARCH/.test(String(msg))));
      assert.ok(calls.some(([name, msg]) => name === "log" && /Rebaked Claude Code/.test(String(msg))));
    });
  });

  it("stops before touching ~/.nexus when it belongs to another program", async () => {
    await withTempHome("finalize-foreign-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await writeFile(path.join(home, ".nexus/settings.ini"), "other=1\n");
      const calls = [];
      const spy = (name) => async () => {
        calls.push(name);
        return { migrated: false, backend: { backend: "keychain" } };
      };

      const result = await finalizeInstallOrUpgrade({
        home,
        installDir: `${home}/.nexus/cli`,
        setupDir: "/nonexistent-setup-for-test",
        log: () => {},
        ensureDeps: () => {
          calls.push("ensureDeps");
          return true;
        },
        reprobe: spy("reprobe"),
        refreshCatalog: spy("refreshCatalog"),
        migrate: spy("migrate"),
        reconcile: spy("reconcile"),
        codexSignIn: spy("codexSignIn"),
      });

      assert.equal(result.renameBlocked, true);
      assert.deepEqual(result.notes, [
        "~/.nexus belongs to another program, so your FireConnect settings stay in ~/.fireconnect. "
        + "Rename or remove ~/.nexus, then upgrade again.",
      ]);
      assert.deepEqual(calls, [], "no deps, key, catalog, or harness step runs against the other program's directory");
      assert.deepEqual(await readdir(path.join(home, ".nexus")), ["settings.ini"]);
    });
  });

  it("prints the per-harness moves off FireRouter once, as one block at the end", async () => {
    await withTempHome("finalize-nexus-auto-moves-", async (home) => {
      const logged = [];
      const result = await finalizeInstallOrUpgrade({
        home,
        setupDir: "/nonexistent-setup-for-test",
        log: (line) => logged.push(line),
        ensureDeps: () => true,
        reprobe: async () => ({ migrated: false }),
        refreshCatalog: async () => {},
        rename: async () => [],
        migrate: async () => [
          "FireRouter is now Nexus Auto: moved OpenCode to `auto`. Restart OpenCode to pick it up.",
          "Refreshed Claude Code's /model picker.",
          "FireRouter is now Nexus Auto: moved Claude Code to `auto`. Restart Claude Code to pick it up.",
        ],
        reconcile: async () => [],
        codexSignIn: async () => [
          "FireRouter is now Nexus Auto: moved Codex to `auto` and removed the FireRouter rows from its model list. Restart Codex to pick it up.",
        ],
        providerKeys: async () => [],
      });
      const block = [
        "Nexus Auto replaces FireRouter:",
        "  - Moved OpenCode to `auto`. Restart OpenCode to pick it up.",
        "  - Moved Claude Code to `auto`. Restart Claude Code to pick it up.",
        "  - Moved Codex to `auto` and removed the FireRouter rows from its model list. Restart Codex to pick it up.",
      ].join("\n");
      assert.deepEqual(logged, ["Refreshed Claude Code's /model picker.", block]);
      assert.deepEqual(result.notes, logged);
    });
  });

  it("swallows reprobe and reconcile failures (best-effort)", async () => {
    await withTempHome("finalize-best-effort-", async (home) => {
      const result = await finalizeInstallOrUpgrade({
        home,
        setupDir: "/nonexistent-setup-for-test",
        log: () => {},
        ensureDeps: () => true,
        reprobe: async () => {
          throw new Error("probe boom");
        },
        migrate: async () => {
          throw new Error("migrate boom");
        },
        reconcile: async () => {
          throw new Error("reconcile boom");
        },
      });
      assert.equal(result.migrated, false);
      assert.deepEqual(result.notes, []);
    });
  });

  it("skips home-side work when HOME is empty", async () => {
    const calls = [];
    const result = await finalizeInstallOrUpgrade({
      home: "",
      installDir: "",
      setupDir: "/nonexistent-setup-for-test",
      log: () => {},
      ensureDeps: () => {
        calls.push("ensureDeps");
        return true;
      },
      reprobe: async () => {
        calls.push("reprobe");
        return { migrated: false, backend: { backend: "plaintext" } };
      },
      migrate: async () => {
        calls.push("migrate");
        return ["should-not-run"];
      },
      reconcile: async () => {
        calls.push("reconcile");
        return ["should-not-run"];
      },
    });
    assert.deepEqual(calls, []);
    assert.equal(result.migrated, false);
    assert.deepEqual(result.notes, []);
  });
});

describe("refreshModelSources", () => {
  it("refreshes the cache when a key resolves and the fetch succeeds", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "fc-refresh-"));
    const prevHome = process.env.HOME;
    const prevKey = process.env.FIREWORKS_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.HOME = home;
    process.env.FIREWORKS_API_KEY = "fw_test_refresh_key";
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ object: "list", data: [mockServerlessModel()] }),
    });
    try {
      assert.equal((await refreshModelSources(home)).serverless, true);
      assert.ok(
        readCatalogCache()?.snapshot.entries.some((entry) => entry.shortId === "glm-5p2"),
        "fetched rows are persisted",
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (prevKey === undefined) delete process.env.FIREWORKS_API_KEY;
      else process.env.FIREWORKS_API_KEY = prevKey;
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips silently with no resolvable key", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "fc-refresh-nokey-"));
    const prevHome = process.env.HOME;
    const prevKey = process.env.FIREWORKS_API_KEY;
    process.env.HOME = home;
    delete process.env.FIREWORKS_API_KEY;
    try {
      assert.equal((await refreshModelSources(home)).serverless, false);
      assert.equal(readCatalogCache(), null);
    } finally {
      if (prevKey === undefined) delete process.env.FIREWORKS_API_KEY;
      else process.env.FIREWORKS_API_KEY = prevKey;
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the old cache when the fetch fails", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "fc-refresh-offline-"));
    const prevHome = process.env.HOME;
    const prevKey = process.env.FIREWORKS_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.HOME = home;
    process.env.FIREWORKS_API_KEY = "fw_test_refresh_key";
    globalThis.fetch = async () => {
      throw new Error("network unreachable");
    };
    try {
      assert.equal((await refreshModelSources(home)).serverless, false);
      assert.equal(readCatalogCache(), null);
    } finally {
      globalThis.fetch = previousFetch;
      if (prevKey === undefined) delete process.env.FIREWORKS_API_KEY;
      else process.env.FIREWORKS_API_KEY = prevKey;
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
