import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheServerlessCatalogSnapshot,
  getServerlessCatalogSnapshot,
  isCachedServerlessModelRef,
  isCatalogCacheFresh,
  readCatalogCache,
  reloadServerlessCatalogSnapshot,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";

const CACHE_MODULE = fileURLToPath(
  new URL("../../lib/fireworks/serverless-catalog-cache.mjs", import.meta.url),
);

const PRICING_MODULE = fileURLToPath(
  new URL("../../lib/fireworks/pricing.mjs", import.meta.url),
);

// This spec is about the HOME-based default cache path, so it opts out of the
// NEXUS_CACHE_DIR override global-setup applies to every test process.
// Isolation still holds: each case runs under its own temp HOME.
delete process.env.NEXUS_CACHE_DIR;

function sampleSnapshot() {
  return {
    entries: [
      { id: "accounts/fireworks/routers/glm-latest", shortId: "glm-latest", displayName: "GLM 5.2 (Latest)", kind: "serverless" },
      { id: "accounts/fireworks/models/kimi-k3", shortId: "kimi-k3", displayName: "Kimi K3", kind: "serverless" },
    ],
    pricingById: new Map([["glm-latest", { input: 1.4, output: 4.4, tier: "standard" }]]),
    inputModalitiesById: new Map([["glm-latest", ["text"]], ["kimi-k3", ["text", "image"]]]),
    routerBaseModelById: new Map([["accounts/fireworks/routers/glm-latest", "accounts/fireworks/models/glm-5p2"]]),
    contextLengthById: new Map([["glm-latest", 1048576]]),
    supportsToolsById: new Map([["glm-latest", true]]),
  };
}

it("matches full catalog refs exactly and bare refs by short id", () => {
  setServerlessCatalogSnapshot(sampleSnapshot());
  try {
    assert.equal(isCachedServerlessModelRef("glm-latest"), true);
    assert.equal(
      isCachedServerlessModelRef("accounts/fireworks/routers/glm-latest"),
      true,
    );
    assert.equal(
      isCachedServerlessModelRef("accounts/fireworks/models/glm-latest"),
      false,
    );
  } finally {
    setServerlessCatalogSnapshot(null);
  }
});

function withTempHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "fc-cache-test-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

function spawnFreshGet(home) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { getServerlessCatalogSnapshot } from ${JSON.stringify(`file://${CACHE_MODULE}`)};
    const s = getServerlessCatalogSnapshot();
    if (!s) { console.log("null"); process.exit(0); }
    console.log(JSON.stringify({
      entries: (s.entries ?? []).map((e) => e.id),
      mods: s.inputModalitiesById?.get("kimi-k3"),
      pricing: s.pricingById?.get("glm-latest")?.input,
      context: s.contextLengthById?.get("glm-latest"),
      tools: s.supportsToolsById?.get("glm-latest"),
    }));
  `], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

describe("serverless-catalog-cache disk persistence", () => {
  it("persists Maps as JSON and a fresh process lazy-loads the snapshot", () => {
    withTempHome((home) => {
      cacheServerlessCatalogSnapshot(sampleSnapshot());
      // Persisted file exists: a { cachedAt, snapshot } envelope with map pairs as arrays.
      const disk = JSON.parse(
        readFileSync(path.join(home, ".nexus", "catalog-cache.json"), "utf8"),
      );
      assert.equal(disk.snapshot.entries.length, 2);
      assert.ok(Number.isFinite(disk.cachedAt), "cachedAt written for TTL");
      assert.deepEqual(
        disk.snapshot.inputModalitiesById,
        [["glm-latest", ["text"]], ["kimi-k3", ["text", "image"]]],
      );
      // A fresh process (this module isn't loaded there) recovers the catalog.
      const out = spawnFreshGet(home);
      const loaded = JSON.parse(out);
      assert.equal(loaded.entries.length, 2);
      assert.deepEqual(loaded.mods, ["text", "image"]);
      assert.equal(loaded.pricing, 1.4);
      assert.equal(loaded.context, 1048576);
      assert.equal(loaded.tools, true);
    });
  });

  it("prices from the persisted cache in a process that never loaded the catalog", () => {
    // The status line helper is spawned per assistant message and makes no
    // network calls, so the disk snapshot is the only live pricing it can see.
    // Reading the module's in-memory binding instead of lazy-loading left it
    // pricing from the static spec table alone — stale rates for a model whose
    // published price moved, and reference rates for one the table lacks.
    withTempHome(() => {
      cacheServerlessCatalogSnapshot({
        ...sampleSnapshot(),
        pricingById: new Map([
          ["accounts/fireworks/models/brand-new-model", {
            slug: "brand-new-model",
            label: "Brand New Model",
            input: 0.7,
            cachedInput: 0.07,
            output: 2.1,
            tier: "standard",
            source: "",
          }],
        ]),
      });

      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { lookupFireworksPricing } from ${JSON.stringify(`file://${PRICING_MODULE}`)};
        console.log(JSON.stringify(lookupFireworksPricing("accounts/fireworks/models/brand-new-model")));
      `], { env: { ...process.env, HOME: process.env.HOME }, encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);

      const pricing = JSON.parse(child.stdout.trim());
      assert.equal(pricing?.input, 0.7);
      assert.equal(pricing?.output, 2.1);
      assert.equal(pricing?.label, "Brand New Model");
    });
  });

  it("set(null) marks the in-memory snapshot authoritative and never resurrects disk", () => {
    withTempHome((home) => {
      cacheServerlessCatalogSnapshot(sampleSnapshot());
      setServerlessCatalogSnapshot(null);
      assert.equal(getServerlessCatalogSnapshot(), null);
    });
  });

  it("a missing or corrupt cache file is treated as no cache", () => {
    withTempHome((home) => {
      const file = path.join(home, ".nexus", "catalog-cache.json");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "{ not json");
      const out = spawnFreshGet(home);
      assert.equal(out, "null");
    });
  });

  it("isCatalogCacheFresh respects the persisted cachedAt within the TTL", () => {
    withTempHome((home) => {
      cacheServerlessCatalogSnapshot(sampleSnapshot());
      assert.equal(isCatalogCacheFresh(), true);

      // Age the write past the default TTL → stale (but still readable).
      const file = path.join(home, ".nexus", "catalog-cache.json");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.cachedAt = Date.now() - 2 * 60 * 60 * 1000;
      writeFileSync(file, JSON.stringify(raw));
      assert.equal(isCatalogCacheFresh(), false);
      assert.ok(readCatalogCache()?.snapshot, "stale snapshot is still recoverable");
    });
  });

  it("reload picks up rows another process wrote without losing memory on a missing file", () => {
    withTempHome((home) => {
      cacheServerlessCatalogSnapshot(sampleSnapshot());
      assert.equal(getServerlessCatalogSnapshot().entries.length, 2);
      // Another process (e.g. the detached price refresher) adds a row.
      const file = path.join(home, ".nexus", "catalog-cache.json");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.snapshot.entries.push({ id: "accounts/fireworks/models/new-row", shortId: "new-row", displayName: "New", kind: "serverless" });
      writeFileSync(file, JSON.stringify(raw));
      assert.equal(getServerlessCatalogSnapshot().entries.length, 2, "memory is stale until reloaded");
      assert.equal(reloadServerlessCatalogSnapshot().entries.length, 3);
      assert.equal(getServerlessCatalogSnapshot().entries.length, 3);
      // A vanished file keeps memory instead of nulling it.
      rmSync(file, { force: true });
      assert.equal(reloadServerlessCatalogSnapshot().entries.length, 3);
      setServerlessCatalogSnapshot(null);
    });
  });

  it("reads a legacy pre-TTL cache file as stale but usable", () => {
    withTempHome((home) => {
      const file = path.join(home, ".nexus", "catalog-cache.json");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({
        entries: [{ id: "accounts/fireworks/models/kimi-k3", shortId: "kimi-k3", displayName: "Kimi K3", kind: "serverless" }],
        pricingById: [], inputModalitiesById: [], routerBaseModelById: [],
        contextLengthById: [], supportsToolsById: [],
      }));
      const cache = readCatalogCache();
      assert.equal(cache.snapshot.entries.length, 1);
      assert.equal(cache.cachedAt, 0, "legacy has no timestamp");
      assert.equal(isCatalogCacheFresh(), false, "legacy reads as stale → refreshed");
    });
  });
});
