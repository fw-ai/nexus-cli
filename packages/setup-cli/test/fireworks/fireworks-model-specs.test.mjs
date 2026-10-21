import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FIREWORKS_MODEL_SPECS,
  isUsableCachedServerlessPricing,
  lookupFireworksModelCost,
  lookupFireworksModelLimits,
  lookupModelSpec,
  pricingMatchesModelRefTier,
  requiresFastTierPricing,
  resolveFireworksCatalog,
  resolveFireworksModelLabel,
  resolveRouterEntryDisplayName,
  resolveSpecSlug,
  isAutoModelId,
} from "../../lib/fireworks/model-specs.mjs";
import { lookupFireworksPricing } from "../../lib/fireworks/pricing.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { buildOpencodeModelEntry } from "../../lib/harnesses/opencode/core.mjs";
import { buildPiCustomFireworksModelEntry } from "../../lib/harnesses/pi/core.mjs";
import { buildDeepseekFireworksModelEntry } from "../../lib/harnesses/deepseek/core.mjs";
import { assumedModelsDevListed } from "../../lib/harnesses/opencode/catalog-policy.mjs";

describe("fireworks-model-specs", () => {
  it("every priced model has capabilities metadata", () => {
    for (const [slug, spec] of Object.entries(FIREWORKS_MODEL_SPECS)) {
      if (!spec.pricing) {
        continue;
      }
      assert.ok(spec.capabilities, `missing capabilities for ${slug}`);
      assert.equal(typeof spec.capabilities.contextWindow, "number");
      assert.equal(typeof spec.capabilities.maxOutputTokens, "number");
      assert.equal(typeof spec.capabilities.vision, "boolean");
      assert.equal(typeof spec.capabilities.toolCalling, "boolean");
    }
  });

  it("does not append Fast to turbo router display names", () => {
    assert.equal(
      resolveRouterEntryDisplayName(
        "accounts/fireworks/routers/kimi-k2p6-turbo",
        "Kimi K2.6 Turbo",
      ),
      "Kimi K2.6 Turbo",
    );
    assert.equal(
      resolveRouterEntryDisplayName(
        "accounts/fireworks/routers/kimi-k2p6-turbo",
        "Kimi K2.6 Turbo",
        { pricingTier: "fast" },
      ),
      "Kimi K2.6 Turbo",
    );
    assert.equal(
      resolveRouterEntryDisplayName(
        "accounts/fireworks/routers/kimi-k2p6-turbo",
        "Kimi K2.6",
        { pricingTier: "fast" },
      ),
      "Kimi K2.6",
    );
    assert.equal(
      resolveRouterEntryDisplayName(
        "accounts/fireworks/routers/kimi-fast-latest",
        "Kimi K3 Fast",
      ),
      "Kimi K3 Fast (Latest)",
    );
  });

  it("resolves kimi-latest through the catalog router base model", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k3",
        shortId: "kimi-k3",
        displayName: "Kimi K3",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-latest", "accounts/fireworks/models/kimi-k3"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveSpecSlug("kimi-latest"), "kimi-k3");
      assert.equal(resolveFireworksModelLabel("kimi-latest"), "Kimi K3 (Latest)");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("resolves kimi-fast-latest to kimi-k3-fast when the catalog carries its router base", () => {
    setServerlessCatalogSnapshot({
      entries: [
        {
          id: "accounts/fireworks/models/kimi-k3",
          shortId: "kimi-k3",
          displayName: "Kimi K3",
          kind: "serverless",
        },
        {
          id: "accounts/fireworks/models/kimi-k3-fast",
          shortId: "kimi-k3-fast",
          displayName: "Kimi K3 Fast",
          kind: "serverless",
        },
      ],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k3-fast"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveSpecSlug("kimi-fast-latest"), "kimi-k3-fast");
      assert.equal(resolveFireworksModelLabel("kimi-fast-latest"), "Kimi K3 Fast (Latest)");
      const spec = lookupModelSpec("kimi-fast-latest");
      assert.equal(spec?.label, "Kimi K3 Fast");
      assert.equal(spec?.pricing?.tier, "fast");
      assert.equal(spec?.pricing?.input, 4.50);
      assert.equal(lookupFireworksPricing("kimi-fast-latest")?.output, 22.50);
      assert.equal(lookupFireworksModelCost("kimi-fast-latest")?.input, 4.50);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("does not invent a target for an alias without catalog router base or static spec", () => {
    setServerlessCatalogSnapshot(null);
    assert.equal(resolveSpecSlug("minimax-latest"), "minimax-latest");
    assert.equal(resolveSpecSlug("qwen-plus-latest"), "qwen-plus-latest");
    assert.equal(lookupModelSpec("minimax-latest"), null);
    assert.equal(resolveFireworksModelLabel("deepseek-pro-latest"), null);
  });

  it("ignores standard-tier cache on resolved fast slugs for fast-latest routers", () => {
    setServerlessCatalogSnapshot({
      entries: [
        {
          id: "accounts/fireworks/models/kimi-k3-fast",
          shortId: "kimi-k3-fast",
          displayName: "Kimi K3 Fast",
          kind: "serverless",
        },
      ],
      pricingById: new Map([
        ["accounts/fireworks/models/kimi-k3-fast", {
          slug: "kimi-k3-fast",
          label: "Kimi K3 Fast",
          input: 0.95,
          cachedInput: 0.19,
          output: 4.00,
          tier: "standard",
          source: "https://docs.fireworks.ai/serverless/pricing",
        }],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k3-fast"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const pricing = lookupFireworksPricing("kimi-fast-latest");
      assert.equal(pricing?.tier, "fast");
      assert.equal(pricing?.input, 4.50);
      assert.equal(pricing?.output, 22.50);
      assert.equal(lookupFireworksModelCost("kimi-fast-latest")?.input, 4.50);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("rejects priority-tier cache for -latest router aliases at lookup", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/routers/kimi-latest",
        shortId: "kimi-latest",
        displayName: "Kimi Latest",
        baseModelId: "accounts/fireworks/models/kimi-k3",
        kind: "serverless",
      }],
      pricingById: new Map([
        ["accounts/fireworks/routers/kimi-latest", {
          slug: "kimi-latest",
          label: "Kimi K3",
          input: 3.75,
          cachedInput: 0.375,
          output: 18.75,
          tier: "priority",
          source: "https://docs.fireworks.ai/serverless/pricing",
        }],
        ["accounts/fireworks/models/kimi-k3", {
          slug: "kimi-k3",
          label: "Kimi K3",
          input: 3.75,
          cachedInput: 0.375,
          output: 18.75,
          tier: "priority",
          source: "https://docs.fireworks.ai/serverless/pricing",
        }],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-latest", "accounts/fireworks/models/kimi-k3"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const pricing = lookupFireworksPricing("kimi-latest");
      assert.equal(pricing?.tier, "standard");
      assert.equal(pricing?.input, 3);
      assert.equal(pricing?.output, 15);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("pricingMatchesModelRefTier enforces bidirectional tier expectations", () => {
    const fastPricing = { input: 3, cachedInput: 0.3, output: 15, tier: "fast" };
    const standardPricing = { input: 0.95, cachedInput: 0.19, output: 4, tier: "standard" };
    const priorityPricing = { input: 3.75, cachedInput: 0.375, output: 18.75, tier: "priority" };

    assert.equal(requiresFastTierPricing("kimi-fast-latest"), true);
    assert.equal(requiresFastTierPricing("kimi-k2p6-turbo"), true);
    assert.equal(requiresFastTierPricing("glm-5p2-fast-us"), true);
    assert.equal(requiresFastTierPricing("kimi-latest"), false);

    assert.equal(pricingMatchesModelRefTier("kimi-fast-latest", fastPricing), true);
    assert.equal(pricingMatchesModelRefTier("kimi-fast-latest", standardPricing), false);
    assert.equal(pricingMatchesModelRefTier("kimi-latest", fastPricing), false);
    assert.equal(pricingMatchesModelRefTier("kimi-latest", standardPricing), true);
    assert.equal(pricingMatchesModelRefTier("kimi-latest", priorityPricing), false);
    assert.equal(isUsableCachedServerlessPricing("kimi-latest", fastPricing), false);
    assert.equal(isUsableCachedServerlessPricing("kimi-latest", standardPricing), true);
    assert.equal(isUsableCachedServerlessPricing("kimi-latest", priorityPricing), false);
  });

  it("prefers live router base models over static spec slugs when catalog cache is warm", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k2p8-code",
        shortId: "kimi-k2p8-code",
        displayName: "Kimi K2.8 Code",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k2p8-code"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveSpecSlug("kimi-fast-latest"), "kimi-k2p8-code-fast");
      assert.equal(resolveFireworksModelLabel("kimi-fast-latest"), "Kimi K2.8 Code Fast (Latest)");
      // No static spec matches the derived slug: the alias is unpriced rather
      // than borrowing an unrelated model's rates.
      assert.equal(lookupModelSpec("kimi-fast-latest"), null);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("keeps Fast in live labels for known -fast router specs", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/glm-5p2",
        shortId: "glm-5p2",
        displayName: "GLM 5.2",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/glm-5p2-fast", "accounts/fireworks/models/glm-5p2"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveFireworksModelLabel("glm-5p2-fast"), "GLM 5.2 Fast");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("follows the catalog for the GLM fast tier rather than a static target", () => {
    // glm-fast-latest is the default Sonnet slot. `resolveSpecSlug` reads the
    // catalog's live router base, so the alias target has to consult the catalog
    // too — otherwise the two disagree and a GLM 5.3 Fast call borrows GLM 5.2
    // Fast's rates.
    //
    // Fast is a serving path, so a tier is published under `routers/`, NOT
    // `models/`: `accounts/fireworks/routers/glm-5p2-fast` is the shipped one.
    // A probe that only looked at `models/` would never see a fast tier.
    const snapshot = (id) => ({
      entries: [{ id, shortId: "glm-5p3-fast", displayName: "GLM 5.3 Fast", kind: "serverless" }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/glm-fast-latest", "accounts/fireworks/models/glm-5p3-fast"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });

    for (const id of [
      "accounts/fireworks/routers/glm-5p3-fast",
      "accounts/fireworks/models/glm-5p3-fast",
    ]) {
      setServerlessCatalogSnapshot(snapshot(id));
      try {
        assert.equal(resolveSpecSlug("glm-fast-latest"), "glm-5p3-fast", id);
      } finally {
        setServerlessCatalogSnapshot(null);
      }
    }

    // The alias needs a live target; the concrete router has static rates.
    assert.equal(resolveSpecSlug("glm-fast-latest"), "glm-fast-latest");
    assert.equal(lookupFireworksPricing("glm-fast-latest"), null);
    assert.equal(FIREWORKS_MODEL_SPECS["glm-5p3-fast"]?.label, "GLM 5.3 Fast");
    assert.equal(lookupFireworksPricing("glm-5p3-fast")?.input, 2.10);
    assert.equal(lookupFireworksPricing("glm-5p3-fast")?.cachedInput, 0.39);
  });

  it("folds dotted served-model ids onto the canonical p-form slug", () => {
    // Claude Code records whatever the gateway stamped on the response, and a
    // transcript can carry both `glm-5p3` and `GLM-5.3` for the same model. Left
    // unfolded they price as two models — one of them unpriced — and every
    // per-model breakdown reports the same release twice.
    for (const ref of ["GLM-5.3", "glm-5.3", "accounts/fireworks/models/GLM-5.3"]) {
      assert.equal(resolveSpecSlug(ref), "glm-5p3", ref);
      assert.equal(lookupModelSpec(ref)?.label, "GLM 5.3", ref);
      assert.equal(lookupFireworksPricing(ref)?.input, 1.40, ref);
    }
    assert.equal(resolveSpecSlug("Kimi-K2.6"), "kimi-k2p6");
  });

  it("does not invent a slug for a dotted id with no matching spec", () => {
    // Folding is only safe because it must land on a model we know; an id that
    // merely looks dotted must survive verbatim.
    for (const ref of ["glm-9.9", "not-a-real-1.0", "FW-GLM-5.2"]) {
      assert.equal(resolveSpecSlug(ref), ref, ref);
      assert.equal(lookupFireworksPricing(ref), null, ref);
    }
  });

  it("does not invent a rate by stripping -latest off an id", () => {
    // `-latest` and pinned ids are mutually exclusive by design: `-latest`
    // tracks current versions while a pinned id names one and does not. So
    // `glm-5p2-latest` is a contradiction Fireworks does not publish, and
    // stripping `-latest` to reach `glm-5p2` would be inventing a rate for an id
    // nothing serves.
    for (const ref of ["glm-5p2-latest", "glm-5p3-latest", "glm-5p2-fast-latest"]) {
      assert.equal(resolveSpecSlug(ref), ref, ref);
      assert.equal(lookupFireworksPricing(ref), null, ref);
    }
    // The real `-latest` aliases resolve only through the catalog; with no
    // snapshot warm they stay unresolved rather than guessing a target.
    assert.equal(resolveSpecSlug("glm-latest"), "glm-latest");
    assert.equal(resolveSpecSlug("glm-flash-latest"), "glm-flash-latest");
    assert.equal(resolveSpecSlug("not-real-latest"), "not-real-latest");
  });

  it("resolves -latest aliases from the live catalog router base", () => {
    // The catalog's routerBaseModelById (fed by the API's aliases field) is the
    // only alias resolver: whenever the catalog can say, it wins — otherwise a
    // status line would report a version, and charge a cached-input rate, that
    // no longer matches what served the call.
    assert.equal(resolveSpecSlug("glm-latest"), "glm-latest");
    setServerlessCatalogSnapshot({
      entries: [
        { id: "accounts/fireworks/models/glm-5p2", shortId: "glm-5p2", displayName: "GLM 5.2", kind: "serverless" },
        { id: "accounts/fireworks/routers/glm-latest", shortId: "glm-latest", displayName: "GLM Latest", kind: "serverless" },
      ],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/glm-latest", "accounts/fireworks/models/glm-5p2"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveSpecSlug("glm-latest"), "glm-5p2");
      // And the rate follows the observed model, not the static spec: GLM 5.2
      // and 5.3 share input/output rates but differ on cached input.
      assert.equal(lookupFireworksPricing("glm-latest")?.cachedInput, 0.14);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
    // No catalog, no static alias target: unpriced.
    assert.equal(lookupFireworksPricing("glm-latest"), null);
  });

  it("resolves firerouter from the shared model spec like other routers", () => {
    const spec = lookupModelSpec("accounts/fireworks/routers/firerouter");
    assert.equal(spec?.label, "FireRouter");
    assert.equal(spec?.capabilities.vision, true);
    assert.equal(lookupFireworksModelLimits("firerouter").contextWindow, 1_048_575);
  });

  it("shares firerouter spec metadata for firerouter* model ids", () => {
    const spec = lookupModelSpec("firerouter/x");
    assert.equal(spec?.label, "FireRouter");
    assert.equal(spec?.capabilities.vision, true);
    const limits = lookupFireworksModelLimits("firerouter/x");
    assert.equal(limits.contextWindow, 1_048_575);
    assert.equal(limits.vision, true);
  });

  it("resolves auto from the static spec without a catalog row", () => {
    const spec = lookupModelSpec("auto");
    assert.equal(spec?.label, "Auto");
    assert.equal(spec?.capabilities.vision, true);
    const limits = lookupFireworksModelLimits("auto");
    assert.equal(limits.contextWindow, 1_048_575);
    assert.equal(limits.vision, true);
  });

  it("shares auto spec metadata for auto-* model ids", () => {
    assert.equal(isAutoModelId("auto"), true);
    assert.equal(isAutoModelId("Auto"), true);
    assert.equal(isAutoModelId("auto[1m]"), true);
    assert.equal(isAutoModelId("auto-instant"), true);
    assert.equal(isAutoModelId("Auto-Instant[1m]"), true);
    assert.equal(isAutoModelId("auto-fast"), true);
    assert.equal(isAutoModelId("automatic"), false);
    assert.equal(isAutoModelId("auto-smart"), false, "Cursor-native picker is not a Fireworks mix");
    // A slash means the ref names something else that merely contains an
    // auto-shaped segment; matching it would route to the wrong model.
    assert.equal(isAutoModelId("accounts/auto-corp/models/private-model"), false);
    assert.equal(isAutoModelId("accounts/fireworks/deployments/auto-instant"), false);
    assert.equal(isAutoModelId("firerouter/auto-instant"), false);
    const spec = lookupModelSpec("auto-instant");
    assert.equal(spec?.label, "Auto");
    assert.equal(spec?.capabilities.vision, true);
    const limits = lookupFireworksModelLimits("auto-instant");
    assert.equal(limits.contextWindow, 1_048_575);
    assert.equal(limits.vision, true);
  });

  it("exposes shared limits and cost helpers", () => {
    const limits = lookupFireworksModelLimits("accounts/fireworks/routers/glm-5p2-fast");
    const cost = lookupFireworksModelCost("accounts/fireworks/routers/glm-5p2-fast");
    assert.equal(limits.contextWindow, 1_048_575);
    assert.equal(cost.input, 2.1);
    assert.equal(cost.output, 6.6);
  });

  it("resolveFireworksCatalog is the canonical merge of limits, cost, and input", () => {
    const catalog = resolveFireworksCatalog("firerouter");
    assert.equal(catalog.limits.contextWindow, 1_048_575);
    assert.equal(catalog.limits.maxTokens, 131_072);
    assert.equal(catalog.limits.vision, true);
    assert.equal(catalog.toolCalling, true);
    assert.deepEqual(catalog.input, ["text", "image"]);
    assert.deepEqual(lookupFireworksModelLimits("firerouter"), catalog.limits);
    assert.deepEqual(lookupFireworksModelCost("firerouter"), catalog.cost);
  });

  it("harness builders consume resolveFireworksCatalog locally", () => {
    const catalog = resolveFireworksCatalog("firerouter");
    const opencode = buildOpencodeModelEntry("firerouter");
    const pi = buildPiCustomFireworksModelEntry("firerouter", "FireRouter");
    const deepseek = buildDeepseekFireworksModelEntry("firerouter", "FireRouter");
    assert.equal(opencode.limit.context, catalog.limits.contextWindow);
    assert.equal(opencode.limit.output, catalog.limits.maxTokens);
    assert.deepEqual(opencode.modalities?.input, catalog.input);
    assert.equal(pi.contextWindow, catalog.limits.contextWindow);
    assert.equal(pi.maxTokens, catalog.limits.maxTokens);
    assert.equal(deepseek.contextWindow, catalog.limits.contextWindow);
    assert.equal(deepseek.maxTokens, catalog.limits.maxTokens);
  });

  it("resolves inkling limits, pricing, and vision from the static spec", () => {
    const limits = lookupFireworksModelLimits("accounts/fireworks/models/inkling");
    const cost = lookupFireworksModelCost("inkling");
    assert.equal(limits.contextWindow, 1_048_576);
    assert.equal(limits.maxTokens, 131_072);
    assert.equal(limits.vision, true);
    assert.equal(cost.input, 1.00);
    assert.equal(cost.output, 4.05);
    assert.equal(lookupModelSpec("inkling")?.label, "Inkling");
    assert.equal(lookupModelSpec("inkling")?.modelsDev, false);
    assert.equal(assumedModelsDevListed("inkling"), false);
    assert.equal(assumedModelsDevListed("glm-5p2"), true);
  });

  it("lookupFireworksModelCost ignores zero-rate cache and falls back to static spec", () => {
    const ref = "accounts/fireworks/routers/glm-5p2-fast";
    setServerlessCatalogSnapshot({
      entries: [],
      pricingById: new Map([[ref, {
        slug: "glm-5p2-fast", label: "GLM 5.2 Fast",
        input: 0, cachedInput: 0, output: 0, tier: "fast", source: "",
      }]]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const cost = lookupFireworksModelCost(ref);
      assert.ok(cost.input > 0, "zero-rate cache must not shadow documented static rates");
      assert.equal(cost.input, 2.10);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("resolves short router slugs against the warmed capability cache", () => {
    const canonical = "accounts/fireworks/routers/kimi-fast-latest";
    setServerlessCatalogSnapshot({
      entries: [],
      pricingById: new Map(),
      inputModalitiesById: new Map([[canonical, ["text", "image"]]]),
      routerBaseModelById: new Map(),
      contextLengthById: new Map([[canonical, 262_000]]),
      supportsToolsById: new Map([[canonical, true]]),
    });
    try {
      const limits = lookupFireworksModelLimits("kimi-fast-latest");
      assert.equal(limits.contextWindow, 262_000);
      assert.equal(limits.vision, true);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

});
