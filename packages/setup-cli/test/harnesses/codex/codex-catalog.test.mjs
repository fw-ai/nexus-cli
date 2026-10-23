import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addCodexSelectedModel,
  buildCodexAutoCatalogEntry,
  buildCodexCatalog,
  buildCodexCatalogFromSnapshot,
  buildCodexCatalogEntry,
  buildCodexCatalogEntryForRouter,
  buildCodexFirerouterCatalogEntry,
  buildCodexOpenaiCatalogEntry,
  CODEX_AUTO_COMPACT_FRACTION,
  CODEX_CONSTANT_FIELDS,
  CODEX_MINIMAX_UNSUPPORTED_NOTE,
  codexAutoCompactTokenLimit,
  codexCatalogContainsModel,
  codexModelExclusionReason,
  codexRowHasUsableContext,
  filterPickerCatalogForCodex,
  MODEL_OVERRIDES,
  pruneCodexCatalogRows,
  refreshCodexCatalogRows,
  withCodexConstantFields,
} from "../../../lib/harnesses/codex/catalog.mjs";
import {
  MODEL_REASONING,
  REASONING_DESCRIPTIONS,
} from "../../../lib/fireworks/reasoning.mjs";
import {
  autoCatalogEntry,
  buildServerlessCatalogSnapshot,
  inputModalitiesFromModel,
  prettyModelName,
} from "../../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel } from "../../helpers.mjs";

function mockModel(overrides = {}) {
  return mockServerlessModel({
    name: "accounts/fireworks/models/glm-5p2",
    displayName: "GLM 5.2",
    description: "GLM 5.2 is a great model.",
    contextLength: 1048576,
    supportsImageInput: false,
    supportsTools: true,
    kind: "CHAT_COMPLETION_MODEL",
    baseModelDetails: { modelType: "glm_moe_dsa" },
    ...overrides,
  });
}

describe("codex-catalog buildCodexCatalogEntry", () => {
  it("maps fields correctly from a mock API model", () => {
    const entry = buildCodexCatalogEntry(mockModel());
    assert.equal(entry.slug, "glm-5p2");
    assert.equal(entry.display_name, "GLM 5.2");
    assert.equal(entry.context_window, 1048576);
    assert.equal(entry.max_context_window, 1048576);
    assert.equal(entry.auto_compact_token_limit, 838860);
    assert.deepEqual(entry.input_modalities, ["text"]);
    assert.equal(entry.supports_parallel_tool_calls, true);
    assert.equal(entry.reasoning_summary_format, "experimental");
    assert.equal(entry.web_search_tool_type, "text");
    assert.equal(entry.supports_image_detail_original, false);
    assert.equal(entry.description, "GLM 5.2 is a great model.");
    assert.equal(entry.auto_review_model_override, "glm-5p2");
    for (const [key, value] of Object.entries(CODEX_CONSTANT_FIELDS)) {
      assert.deepEqual(entry[key], value, `expected CODEX_CONSTANT_FIELDS.${key}`);
    }
  });

  it("pins guardian auto-review to the servable slug (not codex-auto-review)", () => {
    // Codex defaults the reviewer to the OpenAI-only `codex-auto-review`
    // model, which 404s on the Fireworks gateway and fail-closed denies the
    // action. Every catalog row must carry an override to its own slug.
    const base = mockModel();
    assert.equal(buildCodexCatalogEntry(base).auto_review_model_override, "glm-5p2");
    const router = buildCodexCatalogEntryForRouter(
      "accounts/fireworks/routers/glm-latest",
      base,
      "GLM Latest",
    );
    assert.equal(router.slug, "glm-latest");
    assert.equal(router.auto_review_model_override, "glm-latest");
    assert.equal(buildCodexAutoCatalogEntry("auto").auto_review_model_override, "auto");
    assert.equal(
      buildCodexAutoCatalogEntry("auto-instant").auto_review_model_override,
      "auto-instant",
    );
    assert.equal(buildCodexFirerouterCatalogEntry().auto_review_model_override, "firerouter");
    assert.equal(
      buildCodexFirerouterCatalogEntry("firerouter/x").auto_review_model_override,
      "firerouter/x",
    );
  });

  it("turns tool search on for every row, Claude routes included", () => {
    const base = mockModel();
    const rows = [
      buildCodexCatalogEntry(base),
      buildCodexCatalogEntryForRouter("accounts/fireworks/routers/glm-latest", base, "GLM Latest"),
      buildCodexFirerouterCatalogEntry(),
      buildCodexFirerouterCatalogEntry("firerouter/astra"),
      buildCodexFirerouterCatalogEntry("firerouter/opus"),
      buildCodexAutoCatalogEntry("auto"),
      buildCodexAutoCatalogEntry("auto-instant"),
      buildCodexOpenaiCatalogEntry("gpt-9-sol", {}, null),
    ];
    assert.ok(rows.every((row) => row.supports_search_tool === true), rows.map((row) => row.slug).join(","));
  });

  it("re-stamps tool search onto old rows without reordering keys", () => {
    const rows = [
      { slug: "glm-5p2", supports_search_tool: false, priority: 1 },
      { slug: "firerouter/x", supports_search_tool: false, priority: 1 },
      { slug: "firerouter/opus", supports_search_tool: true, priority: 1 },
      { slug: "auto", supports_search_tool: false, priority: 1 },
      { slug: "gpt-9-sol", supports_search_tool: true, priority: 1 },
      { slug: "gpt-9-sol", supports_search_tool: true, priority: 1, base_instructions: "stock" },
    ];
    const restamped = withCodexConstantFields(rows, null);
    assert.deepEqual(restamped.map((row) => row.supports_search_tool), [true, true, true, true, true, true]);
    for (const row of restamped) {
      assert.deepEqual(Object.keys(row).slice(0, 3), ["slug", "supports_search_tool", "priority"]);
    }
    assert.deepEqual(withCodexConstantFields(restamped, null), restamped);
  });

  it("compacts at 80% of the window so the compaction RPC fits under the gateway limit", () => {
    assert.equal(CODEX_AUTO_COMPACT_FRACTION, 0.8);
    assert.equal(codexAutoCompactTokenLimit(1048576), 838860);
    assert.equal(codexAutoCompactTokenLimit(1048575), 838860);
    assert.equal(codexAutoCompactTokenLimit(262144), 209715);
    assert.equal(codexAutoCompactTokenLimit(0), null);
    assert.equal(codexAutoCompactTokenLimit(Number.NaN), null);
  });

  it("applies MODEL_OVERRIDES for qwen3p7-plus", () => {
    const model = mockModel({
      name: "accounts/fireworks/models/qwen3p7-plus",
      displayName: "Qwen3.7 Plus",
      contextLength: 0,
      supportsImageInput: false,
    });
    const entry = buildCodexCatalogEntry(model);
    assert.equal(entry.context_window, MODEL_OVERRIDES["accounts/fireworks/models/qwen3p7-plus"].contextLength);
    assert.equal(entry.context_window, 262144);
    assert.equal(entry.max_context_window, 262144);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
  });

  for (const [modelName, efforts, summaryFormat] of [
    ["accounts/fireworks/models/glm-5p2", ["low", "medium", "high", "max"], "experimental"],
    ["accounts/fireworks/models/glm-5p3", ["low", "medium", "high", "max"], "experimental"],
    ["accounts/fireworks/models/glm-5p3-fast", ["low", "medium", "high", "max"], "experimental"],
    ["accounts/fireworks/models/glm-5p3-flash", ["low", "medium", "high", "max"], "experimental"],
    ["accounts/fireworks/models/minimax-m2p7", ["low", "medium", "high"], "experimental"],
  ]) {
    it(`uses correct reasoning config for ${modelName.split("/").pop()}`, () => {
      const entry = buildCodexCatalogEntry(mockModel({ name: modelName }));
      assert.equal(entry.default_reasoning_level, undefined);
      assert.deepEqual(entry.supported_reasoning_levels.map((level) => level.effort), efforts);
      assert.equal(entry.reasoning_summary_format, summaryFormat);
    });
  }

  it("builds input_modalities with image when supportsImageInput is true", () => {
    const entry = buildCodexCatalogEntry(mockModel({ supportsImageInput: true }));
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(entry.web_search_tool_type, "text_and_image");
    assert.equal(entry.supports_image_detail_original, true);
  });

  it("reads image support from the inputModalities array when no boolean is present", () => {
    // Raw API rows carry modalities only as an array (no supportsImageInput).
    const entry = buildCodexCatalogEntry(mockServerlessModel({
      name: "accounts/fireworks/models/deepseek-v4p1-flash",
      displayName: "DeepSeek V4.1 Flash",
      inputModalities: ["text", "image"],
    }));
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(entry.web_search_tool_type, "text_and_image");
    assert.equal(entry.supports_image_detail_original, true);
  });

  it("reads image support from the snake_case input_modalities array", () => {
    const entry = buildCodexCatalogEntry(mockServerlessModel({
      name: "accounts/fireworks/models/deepseek-v4p1-flash",
      display_name: "DeepSeek V4.1 Flash",
      input_modalities: ["text", "image"],
    }));
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(entry.supports_image_detail_original, true);
  });

  it("stays text-only for an array without image and no boolean", () => {
    const entry = buildCodexCatalogEntry(mockServerlessModel({
      name: "accounts/fireworks/models/deepseek-v4-flash-0731",
      inputModalities: ["text"],
    }));
    assert.deepEqual(entry.input_modalities, ["text"]);
    assert.equal(entry.supports_image_detail_original, false);
  });

  it("keeps explicit boolean precedence over a contradicting array", () => {
    const boolWins = buildCodexCatalogEntry(mockServerlessModel({
      name: "accounts/fireworks/models/glm-5p2",
      supportsImageInput: false,
      inputModalities: ["text", "image"],
    }));
    assert.deepEqual(boolWins.input_modalities, ["text"]);
  });

  it("falls through zero context lengths to the next source", () => {
    const entry = buildCodexCatalogEntry(mockServerlessModel({
      name: "accounts/fireworks/models/glm-5p2",
      contextLength: 0,
      context_length: 1048576,
    }));
    assert.equal(entry.context_window, 1048576);
  });

  it("falls back to the 1M default when every context source is zero or missing", () => {
    const entry = buildCodexCatalogEntry(mockServerlessModel({
      name: "accounts/fireworks/models/zero-ctx",
      contextLength: 0,
      context_length: 0,
    }));
    assert.equal(entry.context_window, 1_000_000);
  });

  it("inherits the max ladder via the live router base-model mapping", () => {
    setServerlessCatalogSnapshot({
      entries: [],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/glm-5p3-fast", "accounts/fireworks/models/glm-5p3"],
        ["accounts/fireworks/routers/glm-5p3-flash-us", "accounts/fireworks/models/glm-5p3-flash"],
        ["accounts/fireworks/routers/glm-5p2-fast", "accounts/fireworks/models/glm-5p2"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      for (const name of [
        "accounts/fireworks/routers/glm-5p3-fast",
        "accounts/fireworks/routers/glm-5p3-flash-us",
        "accounts/fireworks/routers/glm-5p2-fast",
      ]) {
        const entry = buildCodexCatalogEntry(mockModel({ name }));
        assert.equal(entry.default_reasoning_level, undefined, name);
        assert.deepEqual(
          entry.supported_reasoning_levels.map((level) => level.effort),
          ["low", "medium", "high", "max"],
          name,
        );
      }
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("advertises max on GLM 5.3 routers via their base model", () => {
    const base = mockModel({ name: "accounts/fireworks/models/glm-5p3", contextLength: 1048576 });
    for (const routerId of [
      "accounts/fireworks/routers/glm-latest",
      "accounts/fireworks/routers/glm-fast-latest",
      "accounts/fireworks/routers/glm-5p3-fast",
    ]) {
      const entry = buildCodexCatalogEntryForRouter(routerId, base, "GLM Router");
      assert.deepEqual(
        entry.supported_reasoning_levels.map((level) => level.effort),
        ["low", "medium", "high", "max"],
        routerId,
      );
    }
  });

  it("sets no default effort on firerouter* and auto* rows (harness default applies)", () => {
    for (const entry of [
      buildCodexFirerouterCatalogEntry(),
      buildCodexFirerouterCatalogEntry("firerouter/x"),
      buildCodexFirerouterCatalogEntry("firerouter/x/y"),
      buildCodexAutoCatalogEntry("auto"),
      buildCodexAutoCatalogEntry("auto-instant"),
    ]) {
      assert.equal(entry.default_reasoning_level, undefined, entry.slug);
      assert.ok(
        entry.supported_reasoning_levels.some((level) => level.effort === "medium"),
        `${entry.slug} ladder must still offer medium`,
      );
    }
  });

  it("uses default reasoning config for an unknown model", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/unknown-model" }));
    assert.equal(entry.default_reasoning_level, undefined);
    assert.deepEqual(entry.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high"]);
    assert.equal(entry.reasoning_summary_format, "experimental");
  });

  it("falls back from a versioned slug to the unversioned base reasoning config", () => {
    // Live catalog returns versioned slugs (e.g. deepseek-v4-flash-0731); the
    // reasoning table is keyed by the unversioned base (deepseek-v4-flash).
    const flash = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/deepseek-v4-flash-0731" }));
    assert.equal(flash.default_reasoning_level, undefined);
    assert.deepEqual(flash.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "max"]);
    const pro = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/deepseek-v4-pro-0813" }));
    assert.equal(pro.default_reasoning_level, undefined);
    assert.deepEqual(pro.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "max"]);
  });

  it("uses the kimi-k3 reasoning config for the current Kimi generation", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/kimi-k3" }));
    assert.equal(entry.default_reasoning_level, undefined);
    assert.deepEqual(entry.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high"]);
  });

  it("offers a multi-tier effort ladder for every catalog model", () => {
    // The app only renders a selectable Effort row when a model advertises more
    // than one tier — a single-tier model looks frozen at its default.
    for (const [name, config] of Object.entries(MODEL_REASONING)) {
      assert.ok(config.levels.length > 1, `${name} must expose more than one effort tier`);
    }
  });
});

describe("codex-catalog buildCodexCatalogEntryForRouter", () => {
  it("overrides slug and display_name while inheriting base metadata", () => {
    const base = mockModel({ name: "accounts/fireworks/models/glm-5p2", contextLength: 1048576 });
    const entry = buildCodexCatalogEntryForRouter(
      "accounts/fireworks/routers/glm-latest",
      base,
      "GLM Latest",
    );
    assert.equal(entry.slug, "glm-latest");
    assert.equal(entry.display_name, "GLM Latest");
    assert.equal(entry.context_window, 1048576);
    assert.equal(entry.max_context_window, 1048576);
    assert.equal(entry.auto_compact_token_limit, 838860);
  });
});

describe("codex-catalog buildCodexCatalog", () => {

  it("dynamically adds firerouter* entries with shared FireRouter metadata", () => {
    const base = buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot([]), []);
    const models = addCodexSelectedModel(base.models, base, "firerouter/x");
    const entry = models.find((model) => model.slug === "firerouter/x");
    assert.ok(entry);
    assert.equal(entry.context_window, 1_048_575);
    assert.equal(entry.auto_compact_token_limit, 838860);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(entry.supports_parallel_tool_calls, true);
    assert.equal(
      entry.description,
      "Smart routing: automatically picks the best model for the task.",
    );
    assert.equal(codexCatalogContainsModel({ models }, "firerouter/x"), true);
    assert.equal(
      addCodexSelectedModel(models, base, "firerouter/x"),
      models,
      "idempotent when already present",
    );
  });

  it("dynamically adds an auto entry so Codex can resolve its context", () => {
    const base = buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot([]), []);
    const models = addCodexSelectedModel(base.models, base, "auto");
    const entry = models.find((model) => model.slug === "auto");
    assert.ok(entry);
    assert.equal(entry.display_name, "Auto");
    assert.equal(entry.context_window, 1_048_575);
    assert.equal(entry.auto_compact_token_limit, 838860);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(entry.supports_parallel_tool_calls, true);
    assert.equal(codexCatalogContainsModel({ models }, "auto"), true);
    assert.equal(
      addCodexSelectedModel(models, base, "auto"),
      models,
      "idempotent when already present",
    );
  });

  it("dynamically adds an auto-* entry so Codex can resolve its context", () => {
    const base = buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot([]), []);
    const models = addCodexSelectedModel(base.models, base, "auto-instant");
    const entry = models.find((model) => model.slug === "auto-instant");
    assert.ok(entry);
    assert.equal(entry.display_name, "Auto Instant");
    assert.equal(entry.context_window, 1_048_575);
    assert.equal(entry.auto_compact_token_limit, 838860);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(codexCatalogContainsModel({ models }, "auto-instant"), true);
  });

  it("builds the synthesized auto catalog entry from the registerable set", () => {
    // loadCodexCatalogBundle prepends the auto mix to the registerable entries;
    // the snapshot builder must turn that entry into a full auto row (the
    // default `on` registers auto without an explicit --model).
    const snapshot = buildServerlessCatalogSnapshot([mockModel()]);
    const entries = [...snapshot.entries, autoCatalogEntry()];
    const catalog = buildCodexCatalogFromSnapshot({ ...snapshot, entries }, [mockModel()]);
    const entry = catalog.models.find((model) => model.slug === "auto");
    assert.ok(entry, "auto is missing from the Codex catalog");
    assert.equal(entry.display_name, "Auto");
    assert.equal(entry.context_window, 1_048_575);
    assert.equal(entry.auto_compact_token_limit, 838860);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(entry.supports_parallel_tool_calls, true);
    assert.equal(codexCatalogContainsModel(catalog, "auto"), true);
  });

  it("leaves the catalog alone for an ordinary off-catalog model", () => {
    const base = buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot([]), []);
    assert.equal(addCodexSelectedModel(base.models, base, "not-a-real-model"), base.models);
  });

  it("sets a usable auto-compact limit on every catalog row", () => {
    const catalog = buildCodexCatalog([
      mockModel(),
      mockModel({
        name: "accounts/fireworks/models/qwen3p7-plus",
        contextLength: 0,
        supportsImageInput: false,
      }),
    ]);
    assert.ok(catalog.models.length > 0);
    for (const entry of catalog.models) {
      assert.ok(entry.auto_compact_token_limit > 0, `${entry.slug} must auto-compact`);
      assert.ok(
        entry.auto_compact_token_limit < entry.context_window,
        `${entry.slug} must compact before hitting the limit`,
      );
    }
  });

  it("synthesizes a served concrete router collapsed out of the picker list", () => {
    const rows = [
      mockModel({
        name: "accounts/fireworks/models/glm-5p3",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p3-fast",
      }),
    ];
    const catalog = buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot(rows), rows);
    const models = addCodexSelectedModel([], catalog, "glm-5p3-fast");
    const entry = models.find((model) => model.slug === "glm-5p3-fast");
    assert.ok(entry);
    assert.equal(entry.context_window, 1048576);
  });

  it("resolves alias routers from snapshot maps when the base row is pruned", () => {
    // Offline/stale-cache builds have no rawModels to borrow base metadata
    // from, and preferLatestAliases prunes base models whose family has a
    // -latest alias — the maps still carry the base metadata, so the alias
    // router must resolve from them instead of being dropped.
    const rows = [
      mockModel({
        name: "accounts/fireworks/models/alpha-base",
        displayName: "Alpha Base",
        aliases: ["accounts/fireworks/routers/alpha-latest"],
      }),
    ];
    const snapshot = buildServerlessCatalogSnapshot(rows);
    const pruned = {
      ...snapshot,
      entries: snapshot.entries.filter((entry) => entry.id !== "accounts/fireworks/models/alpha-base"),
    };
    const catalog = buildCodexCatalogFromSnapshot(pruned, []);
    const entry = catalog.models.find((model) => model.slug === "alpha-latest");
    assert.ok(entry, "alias router dropped from stale catalog");
    assert.ok(entry.context_window > 0);
  });

  it("does not add a catalog row for MiniMax", () => {
    const base = buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot([]), []);
    assert.equal(addCodexSelectedModel(base.models, base, "minimax-m3"), base.models);
  });

  it("keeps a superseded generation the snapshot still serves", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({ name: "accounts/fireworks/models/kimi-k2p5" }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("kimi-k2p5"));
    assert.ok(slugs.includes("glm-5p2"));
  });

  it("filters out minimax models and minimax-latest router", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({ name: "accounts/fireworks/models/minimax-m2p5" }),
      mockModel({ name: "accounts/fireworks/models/minimax-m2p7" }),
      mockModel({
        name: "accounts/fireworks/models/minimax-m3",
        displayName: "MiniMax M3",
      }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("glm-5p2"));
    assert.ok(!slugs.includes("minimax-m2p5"));
    assert.ok(!slugs.includes("minimax-m2p7"));
    assert.ok(!slugs.includes("minimax-m3"));
    assert.ok(!slugs.includes("minimax-latest"));
  });

  it("documents why MiniMax is excluded from Codex", () => {
    assert.equal(codexModelExclusionReason("minimax-m3"), CODEX_MINIMAX_UNSUPPORTED_NOTE);
    assert.equal(codexModelExclusionReason("accounts/fireworks/routers/minimax-latest"), CODEX_MINIMAX_UNSUPPORTED_NOTE);
    assert.equal(codexModelExclusionReason("glm-5p2"), "");
  });

  it("filters out embedding, flux, and no-tools models", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({ name: "accounts/fireworks/models/embedding-x", kind: "EMBEDDING_MODEL" }),
      mockModel({ name: "accounts/fireworks/models/flux-x", kind: "FLUMINA_BASE_MODEL" }),
      mockModel({ name: "accounts/fireworks/models/no-tools", supportsTools: false }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("glm-5p2"));
    assert.ok(!slugs.includes("embedding-x"));
    assert.ok(!slugs.includes("flux-x"));
    assert.ok(!slugs.includes("no-tools"));
  });

  it("keeps unknown-window models with the 1M default instead of filtering them", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/zero-ctx", contextLength: 0, context_length: 0 }),
    ]);
    const entry = catalog.models.find((row) => row.slug === "zero-ctx");
    assert.ok(entry, "unknown-window row must be kept");
    assert.equal(entry.context_window, 1_000_000);
  });

  it("defaults missing tool support to true instead of filtering the row", () => {
    const row = mockServerlessModel({ name: "accounts/fireworks/models/new-model" });
    delete row.supportsTools;
    delete row.supports_tools;
    const catalog = buildCodexCatalog([row]);
    const entry = catalog.models.find((item) => item.slug === "new-model");
    assert.ok(entry, "row without a tools signal must be kept");
    assert.equal(entry.supports_parallel_tool_calls, true);
  });

  it("reads snake_case API fields from flat serverless rows", () => {
    const catalog = buildCodexCatalog([
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k2p7-code",
        display_name: "Kimi K2.7 Code",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/kimi-k2p7-code-fast",
        aliases: ["accounts/fireworks/routers/kimi-latest"],
        supports_tools: true,
        input_modalities: ["text", "image"],
      }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("kimi-k2p7-code"));
    assert.ok(slugs.includes("kimi-latest"));
    const base = catalog.models.find((entry) => entry.slug === "kimi-k2p7-code");
    const latest = catalog.models.find((entry) => entry.slug === "kimi-latest");
    assert.equal(base.context_window, 1_048_576);
    assert.equal(latest.context_window, 1_048_576);
    assert.equal(base.auto_compact_token_limit, 838860);
    assert.equal(latest.auto_compact_token_limit, 838860);
    assert.equal(base.supports_parallel_tool_calls, true);
    assert.equal(latest.supports_parallel_tool_calls, true);
  });

  it("labels a standalone flat row with its display name, not its resource path", () => {
    const named = mockServerlessModel({
      id: "accounts/fireworks/models/example-model",
      display_name: "Example Model",
    });
    const unnamed = mockServerlessModel({ id: "accounts/fireworks/models/example-two" });
    delete unnamed.display_name;
    const rows = [named, unnamed];
    const catalog = buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot(rows), rows);
    const label = (slug) => catalog.models.find((entry) => entry.slug === slug)?.display_name;
    assert.equal(label("example-model"), "Example Model");
    assert.equal(label("example-two"), prettyModelName("example-two"));
  });

  it("marks alias rows vision-capable from the API inputModalities array", () => {
    // Regression: a boolean-only read rendered every -latest alias text-only
    // while the matrix attached images (deepseek-flash-latest refused view_image).
    const rows = [
      mockServerlessModel({
        name: "accounts/fireworks/models/deepseek-v4p1-flash",
        display_name: "DeepSeek V4.1 Flash",
        input_modalities: ["text", "image"],
        aliases: ["accounts/fireworks/routers/deepseek-flash-latest"],
      }),
    ];
    const catalog = buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot(rows), rows);
    const latest = catalog.models.find((entry) => entry.slug === "deepseek-flash-latest");
    assert.ok(latest, "alias row must exist");
    assert.deepEqual(latest.input_modalities, ["text", "image"]);
    assert.equal(latest.supports_image_detail_original, true);
    assert.equal(latest.web_search_tool_type, "text_and_image");
  });

  it("agrees with the snapshot modality mapping for every row shape", () => {
    // Guard: entry and snapshot must read vision the same way, or the matrix
    // attaches images Codex refuses. Real rows carry array or boolean, never both.
    const legacyImage = mockServerlessModel({ supportsImageInput: true });
    delete legacyImage.input_modalities;
    const legacyText = mockServerlessModel({ supportsImageInput: false });
    delete legacyText.input_modalities;
    for (const row of [
      mockServerlessModel({ name: "accounts/fireworks/models/deepseek-v4p1-flash", inputModalities: ["text", "image"] }),
      mockServerlessModel({ name: "accounts/fireworks/models/deepseek-v4p1-flash", input_modalities: ["text", "image"] }),
      mockServerlessModel({ name: "accounts/fireworks/models/deepseek-v4-flash-0731", inputModalities: ["text"] }),
      { ...legacyImage, name: "accounts/fireworks/models/glm-5p2" },
      { ...legacyText, name: "accounts/fireworks/models/glm-5p2" },
    ]) {
      const expected = inputModalitiesFromModel(row).includes("image");
      const entry = buildCodexCatalogEntry(row);
      assert.deepEqual(
        entry.input_modalities,
        expected ? ["text", "image"] : ["text"],
        JSON.stringify(row),
      );
    }
  });

  it("includes router entries from usage_identifier when base models are present", () => {
    const catalog = buildCodexCatalog([
      mockModel({
        name: "accounts/fireworks/models/glm-5p2",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
      }),
      mockModel({
        name: "accounts/fireworks/models/kimi-k2p7-code",
        displayName: "Kimi K2.7 Code",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/kimi-k2p7-code-fast",
        aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
      }),
    ]);
    const routerSlugs = catalog.models.map((entry) => entry.slug);
    assert.ok(routerSlugs.includes("glm-5p2-fast"));
    assert.ok(routerSlugs.includes("kimi-fast-latest"));
    const glmFast = catalog.models.find((entry) => entry.slug === "glm-5p2-fast");
    assert.equal(glmFast.context_window, 1048576);
    assert.equal(glmFast.auto_compact_token_limit, 838860);
    assert.equal(glmFast.display_name, "GLM 5.2 Fast");
  });

  it("registers the kimi latest aliases the API reports on kimi-k2p7-code", () => {
    const catalog = buildCodexCatalog([
      mockModel({
        name: "accounts/fireworks/models/kimi-k2p7-code",
        displayName: "Kimi K2.7 Code",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/kimi-k2p7-code-fast",
        aliases: [
          "accounts/fireworks/routers/kimi-latest",
          "accounts/fireworks/routers/kimi-fast-latest",
        ],
      }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("kimi-fast-latest"));
    assert.ok(slugs.includes("kimi-latest"));
  });

  it("registers kimi-fast-latest when the API reports it on kimi-k3", () => {
    const catalog = buildCodexCatalog([
      mockModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/kimi-k3-fast",
        aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
      }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("kimi-k3-fast"));
    assert.ok(slugs.includes("kimi-fast-latest"));
  });

  it("skips routers whose base models are missing from the API response", () => {
    const rows = [
      mockModel({
        name: "accounts/fireworks/models/glm-5p2",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
      }),
    ];
    const snapshot = buildServerlessCatalogSnapshot(rows);
    // A router row can outlive its base (e.g. after the base is retired); Codex
    // must skip it rather than emit a router with no base metadata.
    snapshot.entries.push({
      id: "accounts/fireworks/routers/kimi-fast-latest",
      shortId: "kimi-fast-latest",
      displayName: "Kimi Fast (Latest)",
      baseModelId: "accounts/fireworks/models/kimi-k3",
      kind: "serverless",
    });
    const catalog = buildCodexCatalogFromSnapshot(snapshot, rows);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("glm-5p2-fast"));
    assert.ok(!slugs.includes("kimi-fast-latest"));
  });

  it("qwen3p7-plus is included despite zero API contextLength via overrides", () => {
    const catalog = buildCodexCatalog([
      mockModel({
        name: "accounts/fireworks/models/qwen3p7-plus",
        contextLength: 0,
        supportsImageInput: false,
      }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("qwen3p7-plus"));
    const entry = catalog.models.find((entry) => entry.slug === "qwen3p7-plus");
    assert.equal(entry.context_window, 262144);
    assert.equal(entry.auto_compact_token_limit, 209715);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
  });

  it("reasoning level descriptions match REASONING_DESCRIPTIONS", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/minimax-m2p7" }));
    for (const level of entry.supported_reasoning_levels) {
      assert.equal(level.description, REASONING_DESCRIPTIONS[level.effort]);
    }
  });

  it("filterPickerCatalogForCodex keeps only picker entries present in codex catalog", () => {
    const codexCatalog = buildCodexCatalog([mockModel()]);
    const pickerCatalog = [
      { id: "accounts/fireworks/models/glm-5p2", shortId: "glm-5p2", displayName: "GLM 5.2", kind: "serverless" },
      { id: "accounts/fireworks/models/unknown-model", shortId: "unknown-model", displayName: "Unknown", kind: "serverless" },
    ];
    const filtered = filterPickerCatalogForCodex(pickerCatalog, codexCatalog);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].shortId, "glm-5p2");
  });

  it("filterPickerCatalogForCodex returns empty when codex catalog has no models", () => {
    const pickerCatalog = [
      { id: "accounts/fireworks/models/glm-5p2", shortId: "glm-5p2", displayName: "GLM 5.2", kind: "serverless" },
    ];
    const filtered = filterPickerCatalogForCodex(pickerCatalog, { models: [] });
    assert.deepEqual(filtered, []);
  });

  it("matches canonical and short model ids against old and new catalog slugs", () => {
    const shortCatalog = { models: [{ slug: "glm-5p2" }] };
    const canonicalCatalog = {
      models: [{ slug: "accounts/fireworks/models/glm-5p2" }],
    };
    assert.equal(
      codexCatalogContainsModel(shortCatalog, "accounts/fireworks/models/glm-5p2"),
      true,
    );
    assert.equal(codexCatalogContainsModel(canonicalCatalog, "glm-5p2"), true);
  });

  it("does not collapse path-shaped model ids to their final segment", () => {
    const catalog = { models: [{ slug: "test-model" }] };
    assert.equal(codexCatalogContainsModel(catalog, "firerouter/test-model"), false);
  });
});

describe("codex-catalog pruneCodexCatalogRows", () => {
  function pruneRows({ existingModels, snapshot }) {
    return pruneCodexCatalogRows(existingModels, snapshot);
  }
  function suitableRows() {
    return [
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p2",
        display_name: "GLM 5.2",
        supports_tools: true,
      }),
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p2",
        display_name: "GLM 5.2",
        supports_tools: true,
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
      }),
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p3",
        display_name: "GLM-5.3",
        supports_tools: true,
        aliases: ["accounts/fireworks/routers/glm-latest"],
      }),
    ];
  }

  function snapshotFor(rows) {
    return buildServerlessCatalogSnapshot(rows);
  }

  it("is a no-op when nothing changed", () => {
    const rows = suitableRows();
    const fresh = buildCodexCatalogFromSnapshot(snapshotFor(rows), rows).models;
    const merged = pruneRows({
      existingModels: JSON.parse(JSON.stringify(fresh)),
      snapshot: snapshotFor(rows),
    });
    assert.deepEqual(merged, fresh);
  });

  it("does not add newly served models", () => {
    const rows = suitableRows();
    const fresh = buildCodexCatalogFromSnapshot(snapshotFor(rows), rows).models;
    const existing = fresh.filter((entry) => entry.slug !== "glm-5p3");
    const merged = pruneRows({
      existingModels: existing,
      snapshot: snapshotFor(rows),
    });
    assert.deepEqual(merged.map((entry) => entry.slug), existing.map((entry) => entry.slug));
  });

  it("keeps existing metadata for served rows", () => {
    const rows = suitableRows();
    const fresh = buildCodexCatalogFromSnapshot(snapshotFor(rows), rows).models;
    const existing = JSON.parse(JSON.stringify(fresh)).map((entry) => (
      entry.slug === "glm-5p2" ? { ...entry, display_name: "STALE" } : entry
    ));
    const merged = pruneRows({
      existingModels: existing,
      snapshot: snapshotFor(rows),
    });
    assert.equal(merged.find((entry) => entry.slug === "glm-5p2").display_name, "STALE");
  });

  it("keeps a served concrete router omitted from the preferred set", () => {
    const rows = suitableRows();
    const snapshot = snapshotFor(rows);
    const carried = [{
      ...buildCodexCatalogFromSnapshot(snapshot, rows).models
        .find((entry) => entry.slug === "glm-5p2-fast"),
      display_name: "STALE",
    }];
    const merged = pruneRows({
      existingModels: carried,
      snapshot,
    });
    const router = merged.find((entry) => entry.slug === "glm-5p2-fast");
    assert.ok(router);
    assert.equal(router.display_name, "STALE");
    assert.equal(router.context_window, 1048576);
  });

  it("removes carried rows missing from serverless", () => {
    const rows = suitableRows();
    const snapshot = snapshotFor(rows);
    const fresh = buildCodexCatalogFromSnapshot(snapshot, rows).models;
    const merged = pruneRows({
      existingModels: [...fresh, { slug: "retired-x", display_name: "Retired", context_window: 10 }],
      snapshot,
    });
    assert.ok(!merged.some((entry) => entry.slug === "retired-x"));
  });

  it("keeps synthetic auto and firerouter rows verbatim", () => {
    const rows = suitableRows();
    const snapshot = snapshotFor(rows);
    const fresh = buildCodexCatalogFromSnapshot(snapshot, rows).models;
    const auto = { slug: "auto", display_name: "Auto", context_window: 1048575 };
    const firerouter = { slug: "firerouter", display_name: "FireRouter", context_window: 1048575 };
    const merged = pruneRows({
      existingModels: [...fresh, auto, firerouter],
      snapshot,
    });
    assert.deepEqual(merged.find((entry) => entry.slug === "auto"), auto);
    assert.deepEqual(merged.find((entry) => entry.slug === "firerouter"), firerouter);
  });

  it("does not re-add a carried MiniMax row that serverless still serves", () => {
    const rows = [
      ...suitableRows(),
      mockServerlessModel({
        id: "accounts/fireworks/models/minimax-m3",
        display_name: "MiniMax M3",
        supports_tools: true,
      }),
    ];
    const snapshot = snapshotFor(rows);
    const fresh = buildCodexCatalogFromSnapshot(snapshot, rows).models;
    assert.ok(!fresh.some((entry) => entry.slug === "minimax-m3"), "fresh build excludes it");
    const carriedMinimax = {
      slug: "minimax-m3",
      display_name: "MiniMax M3",
      context_window: 1048576,
      max_context_window: 1048576,
    };
    const merged = pruneRows({
      existingModels: [...fresh, carriedMinimax],
      snapshot,
    });
    assert.ok(!merged.some((entry) => entry.slug === "minimax-m3"));
  });

});

describe("codex-catalog metadata tables", () => {
  it("snapshot maps usage_identifier routers to base models", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockModel({
        name: "accounts/fireworks/models/glm-5p2",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
      }),
    ]);
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/glm-5p2-fast"),
      "accounts/fireworks/models/glm-5p2",
    );
  });

  it("MODEL_REASONING has entries for all documented models", () => {
    const expected = [
      "accounts/fireworks/models/glm-5p2",
      "accounts/fireworks/models/glm-5p3",
      "accounts/fireworks/models/glm-5p3-fast",
      "accounts/fireworks/models/glm-5p3-flash",
      "accounts/fireworks/models/deepseek-v4-flash",
      "accounts/fireworks/models/deepseek-v4-pro",
      "accounts/fireworks/models/kimi-k2p6",
      "accounts/fireworks/models/kimi-k2p7-code",
      "accounts/fireworks/models/minimax-m2p7",
      "accounts/fireworks/models/minimax-m3",
      "accounts/fireworks/models/gpt-oss-120b",
      "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
      "accounts/fireworks/models/qwen3p7-plus",
      "accounts/fireworks/models/kimi-k3",
    ];
    for (const id of expected) {
      assert.ok(MODEL_REASONING[id], `missing reasoning config for ${id}`);
    }
  });
});

describe("codex-catalog refreshCodexCatalogRows", () => {
  const rows = () => [
    mockServerlessModel({
      id: "accounts/fireworks/models/glm-5p2",
      displayName: "GLM 5.2",
      supports_tools: true,
    }),
    mockServerlessModel({
      id: "accounts/fireworks/models/glm-5p3",
      displayName: "GLM 5.3",
      supports_tools: true,
      aliases: ["accounts/fireworks/routers/glm-latest"],
    }),
  ];

  it("re-renders kept rows from the fresh catalog (metadata refresh)", () => {
    const snapshot = buildServerlessCatalogSnapshot(rows());
    const fresh = buildCodexCatalogFromSnapshot(snapshot, rows()).models;
    const existing = JSON.parse(JSON.stringify(fresh)).map((entry) => (
      entry.slug === "glm-5p3" ? { ...entry, display_name: "STALE" } : entry
    ));
    const merged = refreshCodexCatalogRows(existing, snapshot, fresh);
    assert.equal(merged.find((entry) => entry.slug === "glm-5p3").display_name, "GLM 5.3");
    assert.deepEqual(merged.map((entry) => entry.slug), existing.map((entry) => entry.slug),
      "order preserved");
  });

  it("adds newly served rows, prunes delisted ones, keeps synthetic rows verbatim", () => {
    const snapshot = buildServerlessCatalogSnapshot(rows());
    const fresh = buildCodexCatalogFromSnapshot(snapshot, rows()).models;
    const auto = { slug: "auto", display_name: "Auto", context_window: 1048575 };
    const existing = [
      ...fresh.filter((entry) => entry.slug !== "glm-5p3"),
      auto,
      { slug: "retired-x", display_name: "Retired", context_window: 10 },
    ];
    const merged = refreshCodexCatalogRows(existing, snapshot, fresh);
    const slugs = merged.map((entry) => entry.slug);
    assert.ok(slugs.includes("glm-5p3"), "newly served row added");
    assert.ok(!slugs.includes("retired-x"), "delisted row pruned");
    assert.deepEqual(merged.find((entry) => entry.slug === "auto"), auto);
    assert.equal(slugs.length, new Set(slugs).size, "no duplicate rows");
  });

  it("is a no-op when nothing changed", () => {
    const snapshot = buildServerlessCatalogSnapshot(rows());
    const fresh = buildCodexCatalogFromSnapshot(snapshot, rows()).models;
    const merged = refreshCodexCatalogRows(JSON.parse(JSON.stringify(fresh)), snapshot, fresh);
    assert.deepEqual(merged, fresh);
  });

  it("keeps a carried unserved row verbatim, including a written default", () => {
    // A synthetic row that is not in the fresh catalog is carried over
    // as-is: an already-written default may be the user's own override,
    // which nexus cannot distinguish from its own write.
    const snapshot = buildServerlessCatalogSnapshot(rows());
    const fresh = buildCodexCatalogFromSnapshot(snapshot, rows()).models;
    const carried = {
      slug: "gpt-6-astra",
      display_name: "GPT-6 Astra",
      context_window: 1048575,
      default_reasoning_level: "medium",
    };
    const merged = refreshCodexCatalogRows([...fresh, carried], snapshot, fresh);
    const row = merged.find((entry) => entry.slug === "gpt-6-astra");
    assert.deepEqual(row, carried);
    assert.equal(merged.at(-1).slug, "gpt-6-astra", "position preserved");
  });

  it("drops a carried FireRouter row on refresh", () => {
    const snapshot = buildServerlessCatalogSnapshot(rows());
    const fresh = buildCodexCatalogFromSnapshot(snapshot, rows()).models;
    const carried = {
      ...buildCodexFirerouterCatalogEntry("firerouter/x"),
      default_reasoning_level: "medium",
    };
    const merged = refreshCodexCatalogRows([...fresh, carried], snapshot, fresh);
    assert.equal(merged.find((entry) => entry.slug === "firerouter/x"), undefined);
  });
});
