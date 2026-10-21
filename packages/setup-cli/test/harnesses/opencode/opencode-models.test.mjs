import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOpencodeModelEntry,
  opencodeConfigModelRef,
  opencodeNeedsProviderModelOverride,
} from "../../../lib/harnesses/opencode/core.mjs";
import { lookupFireworksModelLimits } from "../../../lib/fireworks/model-specs.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { mockServerlessModel } from "../../helpers.mjs";

describe("opencode model entries", () => {
  it("adds image modalities for kimi latest router aliases", () => {
    // Alias routers resolve only from API-reported `aliases`; seed the base row
    // the way the flat catalog reports it (vision-capable Kimi K3).
    setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k3",
        display_name: "Kimi K3",
        aliases: [
          "accounts/fireworks/routers/kimi-latest",
          "accounts/fireworks/routers/kimi-fast-latest",
        ],
        input_modalities: ["text", "image"],
        context_length: 1_040_000,
      }),
    ]));
    try {
      for (const modelId of [
        "accounts/fireworks/routers/kimi-latest",
        "accounts/fireworks/routers/kimi-fast-latest",
        "kimi-latest",
        "kimi-fast-latest",
      ]) {
        const entry = buildOpencodeModelEntry(modelId);
        assert.deepEqual(
          entry.modalities,
          { input: ["text", "image"] },
          modelId,
        );
      }
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("omits modalities for text-only routers", () => {
    const entry = buildOpencodeModelEntry("accounts/fireworks/routers/glm-5p2-fast");
    assert.equal(entry.modalities, undefined);
    assert.equal(entry.name, "GLM 5.2 Fast");
  });

  it("sets OpenCode limit.context/output for latest router aliases absent from models.dev", () => {
    // -latest aliases are no longer statically mapped; seed the aliases the
    // flat catalog reports so they resolve to their base models' limits.
    setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p3",
        display_name: "GLM 5.3",
        aliases: ["accounts/fireworks/routers/glm-latest"],
        context_length: 1_048_576,
      }),
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p3-flash",
        display_name: "GLM 5.3 Flash",
        aliases: ["accounts/fireworks/routers/glm-flash-latest"],
        input_modalities: ["text", "image"],
        context_length: 1_048_576,
      }),
    ]));
    try {
      for (const modelId of [
        "glm-latest",
        "glm-flash-latest",
        "accounts/fireworks/routers/glm-latest",
        "accounts/fireworks/routers/glm-flash-latest",
      ]) {
        const limits = lookupFireworksModelLimits(modelId);
        const entry = buildOpencodeModelEntry(modelId);
        assert.deepEqual(entry.limit, {
          context: limits.contextWindow,
          output: limits.maxTokens,
        }, modelId);
        assert.ok(entry.limit.context >= 1_000_000, modelId);
      }
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("uses models.dev-compatible full ids for catalog models", () => {
    assert.equal(
      opencodeConfigModelRef("deepseek-v4-flash"),
      "accounts/fireworks/models/deepseek-v4-flash",
    );
    assert.equal(
      opencodeConfigModelRef("accounts/fireworks/routers/glm-5p2-fast"),
      "accounts/fireworks/routers/glm-5p2-fast",
    );
    assert.equal(opencodeConfigModelRef("glm-fast-latest"), "glm-fast-latest");
    assert.equal(opencodeConfigModelRef("kimi-fast-latest"), "kimi-fast-latest");
  });

  it("prefers live catalog labels for latest router overrides", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k3-fast",
        shortId: "kimi-k3-fast",
        displayName: "Kimi K3 Fast",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k3-fast"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const entry = buildOpencodeModelEntry("kimi-fast-latest");
      assert.equal(entry.name, "Kimi K3 Fast (Latest)");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("adds image modalities for firerouter", () => {
    for (const modelId of [
      "accounts/fireworks/routers/firerouter",
      "firerouter",
      "firerouter/x",
    ]) {
      const entry = buildOpencodeModelEntry(modelId);
      assert.deepEqual(
        entry.modalities,
        { input: ["text", "image"] },
        modelId,
      );
      assert.equal(entry.limit.context, 1_048_575, modelId);
    }
  });

  it("requires a provider override for firerouter* ids", () => {
    assert.equal(opencodeNeedsProviderModelOverride("firerouter/x"), true);
  });

  it("requires a provider override for auto and keeps its bare slug", () => {
    // `auto` is absent from models.dev, so OpenCode can only resolve it from a
    // provider entry keyed by the same slug the infer command passes
    // (fireworks-ai/auto).
    assert.equal(opencodeNeedsProviderModelOverride("auto"), true);
    assert.equal(opencodeConfigModelRef("auto"), "auto");
    const entry = buildOpencodeModelEntry("auto");
    assert.equal(entry.name, "Auto");
    assert.deepEqual(entry.modalities, { input: ["text", "image"] });
    assert.equal(entry.limit.context, 1_048_575);
  });

  it("requires a provider override for auto-* and keeps the variant slug", () => {
    assert.equal(opencodeNeedsProviderModelOverride("auto-instant"), true);
    assert.equal(opencodeConfigModelRef("auto-instant"), "auto-instant");
    const entry = buildOpencodeModelEntry("auto-instant");
    assert.equal(entry.name, "Auto Instant");
    assert.deepEqual(entry.modalities, { input: ["text", "image"] });
    assert.equal(entry.limit.context, 1_048_575);
  });

  it("adds image modalities for vision serverless models", () => {
    const entry = buildOpencodeModelEntry("accounts/fireworks/models/kimi-k2p7-code");
    assert.deepEqual(entry.modalities, { input: ["text", "image"] });
    assert.equal(entry.name, "Kimi K2.7 Code");
  });

  it("emits OpenCode cost with snake_case cache_read for priced models", () => {
    const entry = buildOpencodeModelEntry("accounts/fireworks/routers/glm-5p2-fast");
    assert.deepEqual(entry.cost, {
      input: 2.1,
      output: 6.6,
      cache_read: 0.21,
    });
  });

  it("omits cost for unpriced models (firerouter)", () => {
    const entry = buildOpencodeModelEntry("firerouter");
    assert.equal(entry.cost, undefined);
  });
});
