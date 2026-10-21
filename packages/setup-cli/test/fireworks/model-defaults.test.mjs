import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  canonicalRequestedModelId,
  dropRetiredModelId,
  fireworksModelSlug,
  fullFireworksResourceId,
  normalizeModelId,
  resolveDefaultMainModel,
  defaultMainModel,
  shortFireworksModelRef,
  validateModelId,
} from "../../lib/fireworks/model-id.mjs";
import {
  claudeCodeModelId,
  applyClaudeCodeContextPolicy,
  modelQualifiesForClaudeCode1mContext,
} from "../../lib/harnesses/claude/code-context.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  buildServerlessCatalogSnapshot,
  fetchServerlessCatalog,
} from "../../lib/fireworks/models.mjs";
import { mockServerlessModel } from "../helpers.mjs";

// Alias routers (`glm-latest`, `kimi-fast-latest`, `deepseek-flash-latest`, …)
// now exist only as the API's per-row `aliases` on flat serverless rows, so
// these tests seed a catalog snapshot binding each alias to its concrete base.
const ALIAS_BASE_ROWS = [
  mockServerlessModel({
    name: "accounts/fireworks/models/glm-5p2",
    context_length: 1_048_576,
    aliases: [
      "accounts/fireworks/routers/glm-latest",
      "accounts/fireworks/routers/glm-fast-latest",
    ],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/kimi-k3",
    context_length: 1_040_000,
    input_modalities: ["text", "image"],
    usage_identifier: "accounts/fireworks/routers/kimi-k3-fast",
    aliases: [
      "accounts/fireworks/routers/kimi-latest",
      "accounts/fireworks/routers/kimi-fast-latest",
    ],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/deepseek-v4-flash",
    context_length: 1_000_000,
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/deepseek-v4-flash-0731",
    context_length: 1_000_000,
    aliases: ["accounts/fireworks/routers/deepseek-flash-latest"],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/minimax-m2p7",
    context_length: 1_000_000,
    aliases: ["accounts/fireworks/routers/minimax-latest"],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/deepseek-v4-pro",
    context_length: 1_000_000,
    aliases: ["accounts/fireworks/routers/deepseek-pro-latest"],
  }),
];

/** Run `fn` against a warmed catalog binding the alias routers above. */
function withAliasCatalog(fn) {
  setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ALIAS_BASE_ROWS));
  try {
    return fn();
  } finally {
    setServerlessCatalogSnapshot(null);
  }
}

describe("model defaults", () => {
  test("serverless catalog derives fast routers from usage_identifier", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        object: "list",
        data: [mockServerlessModel({
          usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
          aliases: ["accounts/fireworks/routers/glm-latest"],
        })],
      }),
    });

    try {
      const { catalog } = await fetchServerlessCatalog("fw_test_key");
      const ids = catalog.map((entry) => entry.id);
      assert.ok(ids.includes("accounts/fireworks/models/glm-5p2"));
      assert.ok(ids.includes("accounts/fireworks/routers/glm-5p2-fast"));
      assert.ok(ids.includes("accounts/fireworks/routers/glm-latest"));
    } finally {
      globalThis.fetch = previousFetch;
      setServerlessCatalogSnapshot(null);
    }
  });

  test("resolveDefaultMainModel always uses auto", () => {
    assert.equal(resolveDefaultMainModel(), "auto");
    assert.equal(defaultMainModel(), "auto");
  });

  test("latest router short IDs stay as gateway slugs", () => {
    assert.equal(normalizeModelId("glm-latest"), "glm-latest");
    assert.equal(normalizeModelId("glm-fast-latest"), "glm-fast-latest");
    assert.equal(normalizeModelId("glm-5p1-fast"), "glm-5p1-fast");
    assert.equal(normalizeModelId("glm-5p2-fast"), "glm-5p2-fast");
    assert.equal(normalizeModelId("kimi-fast-latest"), "kimi-fast-latest");
    assert.equal(normalizeModelId("kimi-k2p6-fast"), "kimi-k2p6-fast");
    assert.equal(normalizeModelId("kimi-latest"), "kimi-latest");
    assert.equal(normalizeModelId("minimax-latest"), "minimax-latest");
    assert.equal(normalizeModelId("qwen-plus-latest"), "qwen-plus-latest");
    assert.equal(normalizeModelId("auto"), "auto");
    assert.equal(normalizeModelId("Auto"), "auto");
    assert.equal(normalizeModelId("auto[1m]"), "auto");
    // Each mix keeps its own slug — normalizing to `auto` would silently swap a
    // latency-first pin for the slower default mix.
    assert.equal(normalizeModelId("auto-instant"), "auto-instant");
    assert.equal(normalizeModelId("Auto-Instant[1m]"), "auto-instant");
    // Refs that only contain an auto-shaped segment keep their full path.
    assert.equal(
      normalizeModelId("accounts/auto-corp/models/private-model"),
      "accounts/auto-corp/models/private-model",
    );
    assert.equal(normalizeModelId("firerouter/auto-instant"), "firerouter/auto-instant");
    assert.equal(normalizeModelId("FIREROUTER/ASTRA"), "firerouter/astra");
    assert.equal(
      normalizeModelId("accounts/Fireworks/models/kimi-k3"),
      "kimi-k3",
    );
    assert.equal(
      normalizeModelId("fireworks-ai/firerouter"),
      "firerouter",
    );
  });

  test("fullFireworksResourceId expands slugs for catalog lookups", () => {
    assert.equal(fullFireworksResourceId("glm-fast-latest"), "accounts/fireworks/routers/glm-fast-latest");
    assert.equal(fullFireworksResourceId("deepseek-v4-flash"), "accounts/fireworks/models/deepseek-v4-flash");
    assert.equal(fullFireworksResourceId("auto"), "auto");
    assert.equal(fullFireworksResourceId("auto-instant"), "auto-instant");
    assert.equal(shortFireworksModelRef(`${fullFireworksResourceId("glm-fast-latest")}[1m]`), "glm-fast-latest[1m]");
    assert.equal(fireworksModelSlug("glm-fast-latest[1m]"), "glm-fast-latest");
    assert.equal(
      shortFireworksModelRef("accounts/acme/models/private-model"),
      "accounts/acme/models/private-model",
    );
  });

  test("model ID validation shows model and router examples", () => {
    assert.throws(
      () => validateModelId("bad/provider/path", "--model"),
      /--model must be a Fireworks model ID like kimi-k3 or a router ID like glm-latest/,
    );
  });

  test("model ID validation rejects firerouter* gateway patterns", () => {
    for (const id of ["firerouter", "firerouter/x", "firerouter/x[1m]", "FIREROUTER/ASTRA", "firerouter-2"]) {
      assert.throws(
        () => validateModelId(id, "--model"),
        /is a FireRouter route, which is no longer supported/,
        id,
      );
    }
    assert.throws(() => validateModelId("firerouter/x[1m]", "--opus"), /--opus .* is a FireRouter route/);
  });

  test("model ID validation rejects firerouter lookalikes", () => {
    assert.throws(() => validateModelId("foo/firerouter-clone", "--model"), /is a FireRouter route/);
    assert.throws(() => validateModelId("firerouterx/y", "--model"), /is a FireRouter route/);
    assert.throws(() => validateModelId("firerouter/", "--model"), /is a FireRouter route/);
    assert.throws(() => validateModelId("firerouter/..", "--model"), /is a FireRouter route/);
    assert.throws(() => validateModelId("firerouter//kimi", "--model"), /is a FireRouter route/);
    assert.throws(() => validateModelId("fireworks/kimi-k3", "--model"), /--model must be/);
    assert.throws(() => validateModelId("router/kimi-k3", "--model"), /--model must be/);
  });

  test("canonicalRequestedModelId collapses known spellings and rejects junk paths", () => {
    assert.throws(
      () => canonicalRequestedModelId("fireworks-ai/firerouter"),
      /is a FireRouter route, which is no longer supported/,
    );
    assert.throws(
      () => canonicalRequestedModelId("FIREROUTER/ASTRA"),
      /is a FireRouter route, which is no longer supported/,
    );
    assert.equal(canonicalRequestedModelId("accounts/Fireworks/models/kimi-k3"), "kimi-k3");
    assert.equal(canonicalRequestedModelId(""), "");
    assert.throws(
      () => canonicalRequestedModelId("fireworks/kimi-k3"),
      /--model must be a Fireworks model ID/,
    );
    assert.throws(
      () => canonicalRequestedModelId("foo/firerouter"),
      /is a FireRouter route, which is no longer supported/,
    );
    assert.throws(
      () => canonicalRequestedModelId("native"),
      /--model native is not a Fireworks model id/,
    );
    assert.throws(
      () => canonicalRequestedModelId("claude-default"),
      /--model claude-default is not a Fireworks model id/,
    );
  });

  test("GLM fast routers and GLM 5P2 use Claude Code 1m context", () => withAliasCatalog(() => {
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/glm-latest"), "accounts/fireworks/routers/glm-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/glm-fast-latest"), "accounts/fireworks/routers/glm-fast-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/glm-5p2"), "accounts/fireworks/models/glm-5p2[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/glm-5p2-fast"), "accounts/fireworks/routers/glm-5p2-fast[1m]");

    const env = applyClaudeCodeContextPolicy(
      { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" },
      { main: "accounts/fireworks/routers/glm-fast-latest" },
    );
    assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
  }));

  test("Kimi K3 family uses Claude Code 1m context", () => withAliasCatalog(() => {
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/kimi-latest"), "accounts/fireworks/routers/kimi-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/kimi-fast-latest"), "accounts/fireworks/routers/kimi-fast-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/kimi-k3"), "accounts/fireworks/models/kimi-k3[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/kimi-k3-fast"), "accounts/fireworks/routers/kimi-k3-fast[1m]");

    const env = applyClaudeCodeContextPolicy(
      { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" },
      { main: "accounts/fireworks/routers/kimi-fast-latest" },
    );
    assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
  }));

  test("DeepSeek latest routers use Claude Code 1m context", () => withAliasCatalog(() => {
    assert.equal(claudeCodeModelId("deepseek-flash-latest"), "deepseek-flash-latest[1m]");
    assert.equal(claudeCodeModelId("deepseek-pro-latest"), "deepseek-pro-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/deepseek-v4-pro"), "accounts/fireworks/models/deepseek-v4-pro[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/deepseek-v4-flash"), "accounts/fireworks/models/deepseek-v4-flash[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/deepseek-v4-pro-0813"), "accounts/fireworks/models/deepseek-v4-pro-0813[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/deepseek-v4-flash-0731"), "accounts/fireworks/models/deepseek-v4-flash-0731[1m]");
  }));

  test("firerouter* model patterns use Claude Code 1m context", () => {
    assert.equal(claudeCodeModelId("firerouter"), "firerouter[1m]");
    assert.equal(claudeCodeModelId("firerouter[1m]"), "firerouter[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/firerouter"), "accounts/fireworks/routers/firerouter[1m]");
    assert.equal(claudeCodeModelId("firerouter/x"), "firerouter/x[1m]");
    // `auto` uses the same [1m] tag as other 1M Fireworks models; Claude Code
    // strips the suffix before the gateway API call (bare `auto` on the wire).
    assert.equal(claudeCodeModelId("auto"), "auto[1m]");
    assert.equal(claudeCodeModelId("auto[1m]"), "auto[1m]");
    assert.equal(modelQualifiesForClaudeCode1mContext("auto"), true);
    assert.equal(claudeCodeModelId("auto-instant"), "auto-instant[1m]");
    assert.equal(modelQualifiesForClaudeCode1mContext("auto-instant"), true);
    assert.equal(claudeCodeModelId("firerouter/x[1m]"), "firerouter/x[1m]");
    assert.equal(claudeCodeModelId("FireRouter/x"), "FireRouter/x[1m]");
    assert.equal(claudeCodeModelId("firerouterx"), "firerouterx[1m]");

    const env = applyClaudeCodeContextPolicy(
      { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" },
      { main: "firerouter/x" },
    );
    assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
  });

  test("Fable 5.1 qualifies for Claude Code 1m context", () => {
    assert.equal(claudeCodeModelId("claude-fable-5-1"), "claude-fable-5-1[1m]");
    assert.equal(modelQualifiesForClaudeCode1mContext("claude-fable-5-1"), true);
  });

  test("models below 1M context omit the Claude Code [1m] suffix", () => {    assert.equal(claudeCodeModelId("accounts/fireworks/models/gpt-oss-120b"), "accounts/fireworks/models/gpt-oss-120b");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/minimax-latest"), "accounts/fireworks/routers/minimax-latest");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/qwen-plus-latest"), "accounts/fireworks/routers/qwen-plus-latest");
    assert.equal(claudeCodeModelId("kimi-k2p6-fast"), "kimi-k2p6-fast");
    assert.equal(modelQualifiesForClaudeCode1mContext("gpt-oss-120b"), false);
  });

  test("cold fallback aliases qualify via their base model window", () => {
    // With a cold catalog, pinned aliases (kimi-fast-latest) still get [1m]
    // through the static fallback base mapping.
    setServerlessCatalogSnapshot(null);
    try {
      assert.equal(modelQualifiesForClaudeCode1mContext("kimi-fast-latest"), true);
      assert.equal(claudeCodeModelId("kimi-fast-latest"), "kimi-fast-latest[1m]");
      assert.equal(modelQualifiesForClaudeCode1mContext("glm-fast-latest"), true);
      assert.equal(modelQualifiesForClaudeCode1mContext("minimax-latest"), false);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  test("deepseek-flash-latest qualifies via live router base context length", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/deepseek-v4-flash-0731",
        shortId: "deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash (0731)",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/deepseek-flash-latest", "accounts/fireworks/models/deepseek-v4-flash-0731"],
      ]),
      contextLengthById: new Map([
        ["accounts/fireworks/models/deepseek-v4-flash-0731", 1_048_576],
        ["accounts/fireworks/routers/deepseek-flash-latest", 1_048_576],
      ]),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(modelQualifiesForClaudeCode1mContext("deepseek-flash-latest"), true);
      assert.equal(claudeCodeModelId("deepseek-flash-latest"), "deepseek-flash-latest[1m]");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });
});

describe("dropRetiredModelId", () => {
  test("maps every retired spelling to auto and passes other ids through", () => {
    assert.equal(dropRetiredModelId("firerouter"), "auto");
    assert.equal(dropRetiredModelId("firerouter/opus"), "auto");
    assert.equal(dropRetiredModelId("accounts/fireworks/routers/firerouter"), "auto");
    assert.equal(dropRetiredModelId("firerouter[1m]"), "auto");
    assert.equal(dropRetiredModelId("auto-instant"), "auto");
    assert.equal(dropRetiredModelId("Auto-Instant[1m]"), "auto");
    assert.equal(dropRetiredModelId("glm-latest"), "glm-latest");
    assert.equal(dropRetiredModelId("auto"), "auto");
    assert.equal(dropRetiredModelId(""), "");
  });

  test("rejects auto-instant at admission with the auto suggestion", () => {
    assert.throws(
      () => validateModelId("auto-instant", "--model"),
      /--model auto-instant is no longer supported\. Use --model auto instead\./,
    );
    assert.throws(
      () => canonicalRequestedModelId("auto-instant"),
      /is no longer supported\. Use --model auto instead\./,
    );
  });
});
