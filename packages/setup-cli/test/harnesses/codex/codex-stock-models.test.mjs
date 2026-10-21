import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, it } from "node:test";

import {
  buildCodexOpenaiCatalogEntry,
  isCodexOpenaiModelSlug,
  missingCodexSignInRows,
  withCodexConstantFields,
  withCodexSignInRows,
} from "../../../lib/harnesses/codex/catalog.mjs";
import {
  cachedCodexStockModels,
  parseCodexCatalogModels,
  refreshCodexStockModels,
  setCodexStockModelsForTests,
} from "../../../lib/harnesses/codex/stock-models.mjs";
import { scopedCacheFilePath } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { withTempHome } from "../../helpers.mjs";

// A synthetic `codex debug models` document, in the shape stock Codex prints.
const nativeRow = (slug, priority, extra = {}) => ({
  slug,
  display_name: slug.toUpperCase(),
  description: `${slug} from stock Codex.`,
  visibility: "list",
  priority,
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
  context_window: 200_000,
  max_context_window: 800_000,
  input_modalities: ["text", "image"],
  base_instructions: `You are ${slug}.`,
  supports_search_tool: true,
  prefer_websockets: true,
  ...extra,
});
const DEBUG_MODELS = {
  models: [
    nativeRow("gpt-9-astra", 2),
    nativeRow("gpt-9-sol", 1),
    nativeRow("example-internal", 3, { visibility: "hide" }),
    nativeRow("o-example", 4),
  ],
};

afterEach(() => {
  setCodexStockModelsForTests(undefined);
});

describe("stock Codex catalog", () => {
  it("keeps visible rows and drops hidden ones", () => {
    assert.deepEqual(parseCodexCatalogModels(DEBUG_MODELS).map((row) => row.slug), ["gpt-9-astra", "gpt-9-sol", "o-example"]);
    assert.deepEqual(parseCodexCatalogModels(null), []);
    assert.deepEqual(parseCodexCatalogModels({ models: [{ visibility: "list" }, "junk"] }), []);
  });

  it("caches the rows for later processes, and keeps them when a refresh finds nothing", async () => {
    await withTempHome("codex-stock-cache-", async (home) => {
      const saved = { HOME: process.env.HOME, list: process.env.NEXUS_TEST_CODEX_MODELS };
      process.env.HOME = home;
      try {
        process.env.NEXUS_TEST_CODEX_MODELS = JSON.stringify(DEBUG_MODELS);
        assert.equal(await refreshCodexStockModels({ codexHome: path.join(home, ".codex") }), true);
        const onDisk = JSON.parse(await readFile(scopedCacheFilePath("codex-stock-models.json"), "utf8"));
        assert.deepEqual(onDisk.models.map((row) => row.slug), ["gpt-9-astra", "gpt-9-sol", "o-example"]);

        setCodexStockModelsForTests(undefined);
        assert.deepEqual(cachedCodexStockModels().map((row) => row.slug), ["gpt-9-astra", "gpt-9-sol", "o-example"]);

        for (const doc of ['{"models":[]}', "not json"]) {
          process.env.NEXUS_TEST_CODEX_MODELS = doc;
          assert.equal(await refreshCodexStockModels({ codexHome: path.join(home, ".codex") }), false);
          assert.equal(cachedCodexStockModels().length, 3);
        }
      } finally {
        process.env.HOME = saved.HOME;
        if (saved.list === undefined) {
          delete process.env.NEXUS_TEST_CODEX_MODELS;
        } else {
          process.env.NEXUS_TEST_CODEX_MODELS = saved.list;
        }
      }
    });
  });

  it("lists stock Codex's GPT rows in its priority order, as Codex's own rows", () => {
    setCodexStockModelsForTests(parseCodexCatalogModels(DEBUG_MODELS));
    const rows = withCodexSignInRows([]);
    assert.deepEqual(rows.map((row) => row.slug), ["gpt-9-sol", "gpt-9-astra"]);
    assert.ok(isCodexOpenaiModelSlug("gpt-9-astra"));
    assert.ok(!isCodexOpenaiModelSlug("o-example"), "only gpt-* models reach FireRouter");

    const stock = parseCodexCatalogModels(DEBUG_MODELS).find((row) => row.slug === "gpt-9-sol");
    const sol = buildCodexOpenaiCatalogEntry("gpt-9-sol", { "gpt-9-sol": { label: "Ignored", contextWindow: 1 } });
    assert.deepEqual(
      sol,
      { ...stock, prefer_websockets: false, auto_review_model_override: "gpt-9-sol" },
      "stock Codex's row as is, plus only what the Fireworks route needs",
    );
    assert.ok(!rows.some((row) => row.slug.startsWith("firerouter")), "no FireRouter row in the sign-in block");

    assert.deepEqual(missingCodexSignInRows(rows), []);
    assert.deepEqual(missingCodexSignInRows(rows.filter((row) => row.slug !== "gpt-9-astra")), ["gpt-9-astra"]);
  });

  it("re-stamps the transport fields and stock Codex's tool search onto stock Codex's rows", () => {
    const stock = parseCodexCatalogModels({
      models: [nativeRow("gpt-9-sol", 1), nativeRow("gpt-9-mini", 2, { supports_search_tool: false })],
    });
    const [native, mini, fireworks] = withCodexConstantFields([
      { ...nativeRow("gpt-9-sol", 1), supports_search_tool: false },
      { ...nativeRow("gpt-9-mini", 2), supports_search_tool: true },
      { slug: "example-model", base_instructions: "", priority: 5 },
    ], stock);
    assert.equal(native.base_instructions, "You are gpt-9-sol.");
    assert.equal(native.priority, 1);
    assert.equal(native.prefer_websockets, false);
    assert.equal(native.supports_search_tool, true, "an earlier release's off is replaced by stock Codex's on");
    assert.equal(mini.supports_search_tool, false, "stock Codex's own off is kept");
    assert.equal(fireworks.priority, 5, "a re-stamp never reorders the picker");

    const [cold] = withCodexConstantFields([{ ...nativeRow("gpt-9-sol", 1), supports_search_tool: false }], null);
    assert.equal(cold.supports_search_tool, true, "without stock rows, GPT rows follow stock Codex's default");
  });

  it("falls back to models.dev's newest model per family without stock rows", () => {
    setCodexStockModelsForTests(null);
    const slugs = withCodexSignInRows([]).map((row) => row.slug);
    assert.ok(slugs.includes("gpt-6-astra"), slugs.join(", "));
    assert.ok(!slugs.includes("gpt-9-sol"));
  });
});
