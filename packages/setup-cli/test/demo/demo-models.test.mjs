import test from "node:test";
import assert from "node:assert/strict";

import {
  demoModelCatalog,
  demoModelLabel,
  demoModelRates,
  demoFireworksPickerIdsFromCatalog,
  refreshDemoPickerFromServerlessCatalog,
  isAnthropicSlotModel,
  defaultLeftModel,
  defaultRightModel,
  demoSideDisplayLabel,
  ANTHROPIC_SLOT_CONCRETE_IDS,
} from "../../lib/demo/demo-models.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import { mockServerlessModel } from "../helpers.mjs";

// Alias routers (`glm-latest`, `kimi-fast-latest`, …) are API-reported per-row
// `aliases` now, so warm a snapshot to populate the offline demo picker.
const DEMO_ALIAS_ROWS = [
  mockServerlessModel({
    name: "accounts/fireworks/models/glm-5p2",
    aliases: [
      "accounts/fireworks/routers/glm-latest",
      "accounts/fireworks/routers/glm-fast-latest",
    ],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/kimi-k3",
    usage_identifier: "accounts/fireworks/routers/kimi-k3-fast",
    aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
  }),
];

/** Warm the demo picker from a catalog carrying the latest alias routers. */
function withDemoCatalog(fn) {
  setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(DEMO_ALIAS_ROWS));
  refreshDemoPickerFromServerlessCatalog();
  try {
    return fn();
  } finally {
    setServerlessCatalogSnapshot(null);
    refreshDemoPickerFromServerlessCatalog();
  }
}

test("demoFireworksPickerIdsFromCatalog: keeps latest aliases, drops pinned glm-5p1", () => {
  const ids = demoFireworksPickerIdsFromCatalog([
    { id: "accounts/fireworks/models/glm-5p1", shortId: "glm-5p1", displayName: "GLM 5.1", kind: "serverless" },
    { id: "accounts/fireworks/models/glm-5p2", shortId: "glm-5p2", displayName: "GLM 5.2", kind: "serverless" },
    { id: "accounts/fireworks/routers/glm-latest", shortId: "glm-latest", displayName: "GLM Latest", kind: "serverless" },
    { id: "accounts/fireworks/routers/glm-fast-latest", shortId: "glm-fast-latest", displayName: "GLM Fast Latest", kind: "serverless" },
    { id: "accounts/fireworks/routers/glm-5p2-fast", shortId: "glm-5p2-fast", displayName: "GLM 5.2 Fast", kind: "serverless" },
  ]);
  assert.deepEqual(ids, ["auto", "glm-fast-latest", "glm-latest"]);
});

test("refreshDemoPickerFromServerlessCatalog: reads warmed snapshot", () => {
  setServerlessCatalogSnapshot({
    entries: [
      { id: "accounts/fireworks/routers/kimi-fast-latest", shortId: "kimi-fast-latest", displayName: "Kimi Fast Latest", kind: "serverless" },
    ],
    pricingById: new Map(),
    inputModalitiesById: new Map(),
    routerBaseModelById: new Map(),
    contextLengthById: new Map(),
    supportsToolsById: new Map(),
  });
  try {
    refreshDemoPickerFromServerlessCatalog();
    const catalog = demoModelCatalog();
    assert.ok(catalog.some((m) => m.id === "kimi-fast-latest"));
    assert.ok(!catalog.some((m) => m.id === "glm-5p1"));
  } finally {
    setServerlessCatalogSnapshot(null);
    refreshDemoPickerFromServerlessCatalog();
  }
});

test("demoModelCatalog: Anthropic slots first, then latest Fireworks picks", () => withDemoCatalog(() => {
  const catalog = demoModelCatalog();
  const ids = catalog.map((m) => m.id);
  assert.equal(catalog[0].id, "opus");
  assert.ok(ids.includes("auto"));
  assert.ok(!ids.some((id) => id.startsWith("firerouter")));
  assert.ok(ids.includes("glm-fast-latest"));
  assert.ok(ids.includes("glm-latest"));
  assert.ok(ids.includes("kimi-fast-latest"));
  assert.ok(!ids.includes("glm-5p2-fast"));
  assert.ok(!ids.includes("kimi-k3-fast"));
  assert.ok(!ids.includes("deepseek-v4-flash"));
}));

test("demoModelRates: resolves pricing for Fireworks, FireRouter, and Anthropic slots", () => {
  const fw = demoModelRates("glm-5p2-fast");
  assert.ok(fw);
  assert.ok(fw.inputPerMillion > 0);
  const fr = demoModelRates("firerouter");
  assert.ok(fr);
  assert.equal(fr.inputPerMillion, null);
  assert.equal(fr.outputPerMillion, null);
  assert.equal(fr.estimated, true);
  const anth = demoModelRates("opus");
  assert.ok(anth);
  assert.match(anth.label, /via Anthropic/);
  // Sonnet prices off the Anthropic list table: "(via Anthropic)".
  const sonnet = demoModelRates("sonnet");
  assert.ok(sonnet);
  assert.equal(sonnet.label, "Claude Sonnet 5 (via Anthropic)");
  assert.equal(sonnet.inputPerMillion, 2);
  assert.equal(sonnet.outputPerMillion, 10);

  // Every Anthropic slot prices at its concrete canonical id's Anthropic list
  // rate — the incumbent always runs real Anthropic, so a null here (which makes
  // resolveSideRates throw) must never happen, regardless of the live mapping.
  const EXPECTED = {
    opus: { in: 5, out: 25 },
    sonnet: { in: 2, out: 10 },
    haiku: { in: 1, out: 5 },
    fable: { in: 10, out: 50 },
  };
  for (const slot of ["opus", "sonnet", "haiku", "fable"]) {
    const rates = demoModelRates(slot);
    assert.ok(rates, `${slot} must resolve rates`);
    assert.equal(rates.inputPerMillion, EXPECTED[slot].in, `${slot} input rate`);
    assert.equal(rates.outputPerMillion, EXPECTED[slot].out, `${slot} output rate`);
    assert.match(rates.label, /via Anthropic/);
  }
});

test("demoModelRates: auto mixes resolve to an unpriced shape, never null", () => {
  for (const id of ["auto", "auto-instant"]) {
    const rates = demoModelRates(id);
    assert.ok(rates, `${id} must resolve rates instead of crashing resolveSideRates`);
    assert.equal(rates.inputPerMillion, null);
    assert.equal(rates.outputPerMillion, null);
    assert.equal(rates.tier, "unpriced");
    assert.equal(rates.estimated, true);
  }
});

test("demoModelRates: uses live serverless catalog when warmed", () => {
  setServerlessCatalogSnapshot({
    entries: [],
    pricingById: new Map([
      ["accounts/fireworks/models/glm-5p2-fast", {
        slug: "glm-5p2-fast",
        label: "GLM 5.2 Fast",
        input: 0.55,
        cachedInput: 0.055,
        output: 2.19,
        tier: "fast",
        source: "https://fireworks.ai/pricing",
      }],
      ["accounts/fireworks/routers/firerouter", {
        slug: "firerouter",
        label: "FireRouter",
        input: 0.66,
        cachedInput: 0.066,
        output: 2.50,
        tier: "standard",
        source: "https://fireworks.ai/pricing",
      }],
    ]),
    inputModalitiesById: new Map(),
    routerBaseModelById: new Map(),
    contextLengthById: new Map(),
    supportsToolsById: new Map(),
  });
  try {
    const live = demoModelRates("glm-5p2-fast");
    assert.equal(live?.inputPerMillion, 0.55);
    assert.equal(live?.estimated, undefined);
    const router = demoModelRates("firerouter");
    assert.equal(router?.inputPerMillion, 0.66);
    assert.equal(router?.estimated, undefined);
    // A published FireRouter rate must not stand in for the auto mixes.
    for (const id of ["auto", "auto-instant"]) {
      const auto = demoModelRates(id);
      assert.equal(auto?.inputPerMillion, null, `${id} stays unpriced`);
      assert.equal(auto?.outputPerMillion, null, `${id} stays unpriced`);
      assert.equal(auto?.tier, "unpriced");
      assert.match(auto?.label, /auto/i);
      assert.doesNotMatch(auto?.label, /firerouter/i);
    }
  } finally {
    setServerlessCatalogSnapshot(null);
  }
});

test("demoModelRates: anthropic slot ignores the live slot mapping — always real Anthropic", () => {
  // The incumbent side is pinned to a concrete Anthropic id via demoCliModel,
  // bypassing the user's ANTHROPIC_DEFAULT_*_MODEL slot pin. So pricing must
  // reflect real Anthropic at list price regardless of what the slot is pinned
  // to in the live settings (firerouter, a Fireworks model, or claude-default)
  // — never null, never the Fireworks backend's rate.
  const baseline = demoModelRates("opus");
  for (const mapping of [
    { opus: "firerouter[1m]" },
    { opus: "accounts/fireworks/routers/firerouter[1m]" },
    { opus: "glm-fast-latest" },
    { opus: "claude-default" },
    { opus: "claude-opus-4-5" },
  ]) {
    const rates = demoModelRates("opus", mapping);
    assert.ok(rates, `opus with mapping ${JSON.stringify(mapping)} must resolve`);
    assert.equal(rates.inputPerMillion, baseline.inputPerMillion);
    assert.equal(rates.outputPerMillion, baseline.outputPerMillion);
    assert.equal(rates.label, "Claude Opus 5 (via Anthropic)");
  }
});

test("defaults and display labels", () => {
  assert.equal(defaultLeftModel(), "opus");
  assert.equal(defaultRightModel(), "glm-fast-latest");
  assert.match(demoSideDisplayLabel("opus"), /^Anthropic · /);
  assert.match(demoSideDisplayLabel("glm-fast-latest"), /^Fireworks · /);
  assert.equal(demoModelLabel("opus"), "Claude Opus 5");
  assert.equal(isAnthropicSlotModel("fable"), true);
  // Concrete canonical Anthropic ids for the Claude 5 family — single source of
  // truth for both demoCliModel (routing) and demoModelRates (pricing).
  assert.deepEqual(ANTHROPIC_SLOT_CONCRETE_IDS, {
    opus: "claude-opus-5",
    sonnet: "claude-sonnet-5",
    haiku: "claude-haiku-4-5",
    fable: "claude-fable-5-1",
  });
});
