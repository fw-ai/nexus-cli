import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FIREROUTER_MODEL_ID,
  FIREROUTER_ROUTER_ID,
  firerouterNamesAnthropicModel,
  firerouterRequiresAnthropicKey,
  isFirerouterModelPattern,
  isFirerouterModel,
  isFirerouterRouteRef,
  normalizeModelId,
} from "../../lib/fireworks/model-id.mjs";
import {
  buildClaudeCustomHeaders,
  firerouterStatusFromEnv,
} from "../../lib/firerouter/core.mjs";
import {
  catalogWithAutomaticAuto,
  firerouterDisplayName,
  preferLatestAliases,
  registerableModelIds,
} from "../../lib/fireworks/models.mjs";

describe("firerouter model recognition", () => {
  it("recognizes firerouter regardless of prefix or context suffix", () => {
    for (const id of ["firerouter", "FireRouter", "firerouter[1m]", "fireworks-ai/firerouter", "fireworks/firerouter"]) {
      assert.equal(isFirerouterModel(id), true, id);
    }
    for (const id of ["glm-fast-latest", "accounts/fireworks/models/deepseek-v4-flash", "", null, undefined]) {
      assert.equal(isFirerouterModel(id), false, String(id));
    }
  });

  it("matches firerouter* gateway patterns on any path segment", () => {
    for (const id of ["firerouter", "firerouter[1m]", "firerouter/x", "FireRouter/x", "firerouterx", "accounts/fireworks/routers/firerouter"]) {
      assert.equal(isFirerouterModelPattern(id), true, id);
    }
    for (const id of ["glm-fast-latest", "accounts/fireworks/routers/glm-latest", "", null, undefined]) {
      assert.equal(isFirerouterModelPattern(id), false, String(id));
    }
  });

  it("isFirerouterRouteRef admits only bare and rooted firerouter routes", () => {
    for (const id of ["firerouter", "FIREROUTER", "firerouter[1m]", "firerouter/astra", "firerouter/claude-opus-5/kimi-k3", "FIREROUTER/ASTRA"]) {
      assert.equal(isFirerouterRouteRef(id), true, id);
    }
    for (const id of [
      "foo/firerouter-clone",
      "firerouterx/y",
      "router/gpt-5.6-sol",
      "glm-fast-latest",
      "firerouter/",
      "firerouter//kimi",
      "firerouter/astra/",
      "firerouter /astra",
      "firerouter/..",
      "firerouter/../kimi-k3",
      "firerouter/.",
      "",
      null,
      undefined,
    ]) {
      assert.equal(isFirerouterRouteRef(id), false, String(id));
    }
  });

  it("firerouterRequiresAnthropicKey: true for bare firerouter and any Claude/Opus member", () => {
    // Bare firerouter uses Claude Opus when an Anthropic key is present.
    for (const id of [
      "firerouter",
      "firerouter[1m]",
      "accounts/fireworks/routers/firerouter",
      "firerouter/claude-opus-5/kimi-k3-fast",
      "firerouter/claude-sonnet-5",
      "firerouter/kimi-k3/claude-opus-5",
      // Bare Claude picker aliases resolve to Anthropic models.
      "firerouter/sonnet",
      "firerouter/haiku",
      "firerouter/fable",
      "firerouter/opus",
      "firerouter/claude",
    ]) {
      assert.equal(firerouterRequiresAnthropicKey(id), true, id);
    }
    // Pure-Fireworks selections route Fireworks models only — no Anthropic key.
    for (const id of [
      "firerouter/kimi-k3/glm-5p2-fast",
      "firerouter/glm-latest",
      "firerouter/deepseek-v4-flash",
      "kimi-fast-latest",
      "accounts/fireworks/routers/glm-latest",
      "",
      null,
      undefined,
    ]) {
      assert.equal(firerouterRequiresAnthropicKey(id), false, String(id));
    }
  });

  it("firerouterNamesAnthropicModel: true only when the path names a Claude/Opus member", () => {
    for (const id of [
      "firerouter/claude-opus-5/kimi-k3-fast",
      "firerouter/kimi-k3/claude-opus-5",
      "firerouter/opus",
      "firerouter/fable",
    ]) {
      assert.equal(firerouterNamesAnthropicModel(id), true, id);
    }
    // Bare firerouter serves a GPT model or open models without an Anthropic key.
    for (const id of [
      "firerouter",
      "firerouter[1m]",
      "accounts/fireworks/routers/firerouter",
      "firerouter/kimi-k3/glm-5p2-fast",
      "firerouter/astra",
      "kimi-fast-latest",
      "",
      null,
    ]) {
      assert.equal(firerouterNamesAnthropicModel(id), false, String(id));
    }
  });

  it("firerouterDisplayName labels every FireRouter id like auto", () => {
    for (const id of [
      "firerouter",
      "firerouter[1m]",
      "accounts/fireworks/routers/firerouter",
      "firerouter/claude-opus-5/kimi-k3-fast",
      "accounts/fireworks/routers/firerouter/kimi-k3",
    ]) {
      assert.equal(firerouterDisplayName(id), "Auto", id);
    }
  });

  it("normalizeModelId keeps gateway slugs short (no accounts/fireworks expansion)", () => {
    assert.equal(normalizeModelId("firerouter"), FIREROUTER_MODEL_ID);
    assert.equal(normalizeModelId("firerouter[1m]"), FIREROUTER_MODEL_ID);
    assert.equal(normalizeModelId("fireworks-ai/firerouter"), FIREROUTER_MODEL_ID);
    assert.equal(normalizeModelId("accounts/fireworks/routers/firerouter"), FIREROUTER_MODEL_ID);
    assert.equal(normalizeModelId("foo/firerouter"), "foo/firerouter");
    assert.equal(normalizeModelId("accounts/acme/models/firerouter"), "accounts/acme/models/firerouter");
    assert.equal(FIREROUTER_MODEL_ID, "firerouter");
    assert.equal(normalizeModelId("glm-fast-latest"), "glm-fast-latest");
    assert.equal(normalizeModelId("deepseek-v4-flash"), "deepseek-v4-flash");
  });

  it("status detects firerouter in any Claude slot", () => {
    assert.equal(
      firerouterStatusFromEnv({
        ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "firerouter",
      }),
      "firerouter",
    );
    // Direct mode on the same gateway is not firerouter.
    assert.equal(
      firerouterStatusFromEnv({
        ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
        ANTHROPIC_MODEL: "accounts/fireworks/routers/glm-fast-latest",
      }),
      "other",
    );
  });

  it("buildClaudeCustomHeaders adds the Anthropic BYOK header only when a key is present", () => {
    const withByok = buildClaudeCustomHeaders({ fireworksKey: "fw_key", anthropicKey: "sk-ant-byok" });
    assert.match(withByok, /X-Fireworks-Api-Key: fw_key/);
    assert.match(withByok, /x-anthropic-api-key: sk-ant-byok/);

    const noByok = buildClaudeCustomHeaders({ fireworksKey: "fw_key" });
    assert.match(noByok, /X-Fireworks-Api-Key: fw_key/);
    assert.equal(/x-anthropic-api-key/.test(noByok), false);
  });
});

describe("model catalog", () => {
  it("preferLatestAliases keeps aliases or only the newest concrete family version", () => {
    const catalog = [
      { shortId: "deepseek-v3", id: "accounts/fireworks/models/deepseek-v3" },
      { shortId: "deepseek-v4-flash", id: "accounts/fireworks/models/deepseek-v4-flash" },
      { shortId: "deepseek-v4-flash-0731", id: "accounts/fireworks/models/deepseek-v4-flash-0731" },
      { shortId: "deepseek-v4-pro", id: "accounts/fireworks/models/deepseek-v4-pro" },
      { shortId: "deepseek-v4-pro-0813", id: "accounts/fireworks/models/deepseek-v4-pro-0813" },
      { shortId: "deepseek-flash-latest", id: "accounts/fireworks/routers/deepseek-flash-latest", baseModelId: "accounts/fireworks/models/deepseek-v4-flash-0731" },
      { shortId: "deepseek-pro-latest", id: "accounts/fireworks/routers/deepseek-pro-latest", baseModelId: "accounts/fireworks/models/deepseek-v4-pro-0813" },
      { shortId: "gpt-oss-120b", id: "accounts/fireworks/models/gpt-oss-120b" },
      { shortId: "glm-5p1", id: "accounts/fireworks/models/glm-5p1" },
      { shortId: "glm-5p1-fast", id: "accounts/fireworks/routers/glm-5p1-fast", baseModelId: "accounts/fireworks/models/glm-5p1" },
      { shortId: "glm-5p2", id: "accounts/fireworks/models/glm-5p2" },
      { shortId: "glm-5p2-fast", id: "accounts/fireworks/routers/glm-5p2-fast", baseModelId: "accounts/fireworks/models/glm-5p2" },
      { shortId: "glm-fast-latest", id: "accounts/fireworks/routers/glm-fast-latest", baseModelId: "accounts/fireworks/models/glm-5p2" },
      { shortId: "glm-latest", id: "accounts/fireworks/routers/glm-latest", baseModelId: "accounts/fireworks/models/glm-5p2" },
      { shortId: "kimi-k2p7-code", id: "accounts/fireworks/models/kimi-k2p7-code" },
      { shortId: "kimi-latest", id: "accounts/fireworks/routers/kimi-latest", baseModelId: "accounts/fireworks/models/kimi-k2p7-code" },
      { shortId: "minimax-m2p7", id: "accounts/fireworks/models/minimax-m2p7" },
      { shortId: "minimax-m3", id: "accounts/fireworks/models/minimax-m3" },
      { shortId: "minimax-latest", id: "accounts/fireworks/routers/minimax-latest", baseModelId: "accounts/fireworks/models/minimax-m3" },
      { shortId: "qwen3p6-plus", id: "accounts/fireworks/models/qwen3p6-plus" },
      { shortId: "qwen3p7-plus", id: "accounts/fireworks/models/qwen3p7-plus" },
      { shortId: "qwen-plus-latest", id: "accounts/fireworks/routers/qwen-plus-latest", baseModelId: "accounts/fireworks/models/qwen3p7-plus" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, [
      "deepseek-v3",
      "deepseek-flash-latest",
      "deepseek-pro-latest",
      "gpt-oss-120b",
      "glm-fast-latest",
      "glm-latest",
      "kimi-latest",
      "minimax-latest",
      "qwen-plus-latest",
    ]);
  });

  it("preferLatestAliases collapses pure-digit kimi fast models into kimi-fast-latest", () => {
    // kimi-k3-fast (no `p\d`) used to fall through to the per-shortId
    // fallback, so it landed in its own family and wasn't collapsed into the
    // kimi-fast-latest alias. It must share the "kimi" family.
    const catalog = [
      { shortId: "kimi-fast-latest", id: "accounts/fireworks/routers/kimi-fast-latest" },
      { shortId: "kimi-k3-fast", id: "accounts/fireworks/routers/kimi-k3-fast" },
      { shortId: "glm-fast-latest", id: "accounts/fireworks/routers/glm-fast-latest" },
      { shortId: "glm-5p2-fast", id: "accounts/fireworks/routers/glm-5p2-fast" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["kimi-fast-latest", "glm-fast-latest"]);
  });

  it("preferLatestAliases collapses the kimi-k3 base model into the kimi aliases", () => {
    // kimi-k3 (no `p\d`, no `-fast`) matched none of the vendor patterns and
    // leaked into registered catalogs next to kimi-latest/kimi-fast-latest.
    const catalog = [
      { shortId: "kimi-latest", id: "accounts/fireworks/routers/kimi-latest" },
      { shortId: "kimi-fast-latest", id: "accounts/fireworks/routers/kimi-fast-latest" },
      { shortId: "kimi-k3", id: "accounts/fireworks/models/kimi-k3" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["kimi-latest", "kimi-fast-latest"]);
  });

  it("preferLatestAliases collapses unseen families into their own -latest alias", () => {
    // A family the CLI has no vendor rule for: the base slug equals the alias
    // family (possibly with digits/dashes), so it must collapse without a
    // hand-written pattern.
    const catalog = [
      { shortId: "modelfamily-a1b2-abvc-latest", id: "accounts/fireworks/routers/modelfamily-a1b2-abvc-latest" },
      { shortId: "modelfamily-a1b2-abvc", id: "accounts/fireworks/models/modelfamily-a1b2-abvc" },
      { shortId: "newmodel-1p2", id: "accounts/fireworks/models/newmodel-1p2" },
      { shortId: "newmodel-latest", id: "accounts/fireworks/routers/newmodel-latest" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["modelfamily-a1b2-abvc-latest", "newmodel-latest"]);
  });

  it("preferLatestAliases keeps only the newest version of an aliaseless family", () => {
    // No -latest alias for the family: generic version extraction must still
    // group the variants and keep only the newest — whatever the version
    // shape (p-versions, dotted versions, multi-part versions).
    const catalog = [
      { shortId: "acme-1p2", id: "accounts/fireworks/models/acme-1p2" },
      { shortId: "acme-1p3", id: "accounts/fireworks/models/acme-1p3" },
      { shortId: "acme-1p3-fast", id: "accounts/fireworks/routers/acme-1p3-fast" },
      { shortId: "dotco-1.5", id: "accounts/fireworks/models/dotco-1.5" },
      { shortId: "dotco-1.6", id: "accounts/fireworks/models/dotco-1.6" },
      { shortId: "multi-1p2p3", id: "accounts/fireworks/models/multi-1p2p3" },
      { shortId: "multi-1p2p4", id: "accounts/fireworks/models/multi-1p2p4" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["acme-1p3", "acme-1p3-fast", "dotco-1.6", "multi-1p2p4"]);
  });

  it("preferLatestAliases keeps distinct parameter sizes separate", () => {
    // "120b"-style size suffixes are not versions: every size stays visible.
    const catalog = [
      { shortId: "gpt-oss-20b", id: "accounts/fireworks/models/gpt-oss-20b" },
      { shortId: "gpt-oss-120b", id: "accounts/fireworks/models/gpt-oss-120b" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["gpt-oss-20b", "gpt-oss-120b"]);
  });

  it("registerableModelIds passes the served list through, never a FireRouter row", () => {
    const catalog = [
      {
        shortId: "glm-latest",
        id: "accounts/fireworks/routers/glm-latest",
      },
    ];
    assert.deepEqual(
      registerableModelIds(catalog),
      ["accounts/fireworks/routers/glm-latest"],
      "registerableModelIds passes the served list through; loadServerlessCatalog adds auto",
    );
    assert.deepEqual(
      registerableModelIds(
        [{ shortId: "firerouter", id: FIREROUTER_ROUTER_ID }, ...catalog],
      ),
      ["accounts/fireworks/routers/glm-latest"],
    );
  });

  it("registerableModelIds keeps a served auto row", () => {
    const glmLatest = { shortId: "glm-latest", id: "accounts/fireworks/routers/glm-latest" };
    // An auto row could arrive keyed either way — either form survives.
    for (const autoRow of [
      { shortId: "auto", id: "auto" },
      { shortId: "", id: "accounts/fireworks/routers/auto" },
    ]) {
      const catalog = [glmLatest, autoRow];
      assert.deepEqual(
        registerableModelIds(catalog),
        ["accounts/fireworks/routers/glm-latest", autoRow.id],
        autoRow.id,
      );
    }
  });

  it("catalogWithAutomaticAuto prepends auto unless present or empty", () => {
    const glmLatest = { shortId: "glm-latest", id: "accounts/fireworks/routers/glm-latest" };
    assert.deepEqual(
      catalogWithAutomaticAuto([glmLatest]).map((entry) => entry.id),
      ["auto", "accounts/fireworks/routers/glm-latest"],
    );
    const withAuto = [{ shortId: "auto", id: "auto" }, glmLatest];
    assert.equal(catalogWithAutomaticAuto(withAuto), withAuto);
    assert.deepEqual(catalogWithAutomaticAuto([]), [], "empty stays empty");
  });

  it("never registers a FireRouter row the gateway still lists", () => {
    const catalog = [
      { shortId: "auto", id: "auto" },
      { shortId: "firerouter", id: FIREROUTER_ROUTER_ID },
      { shortId: "glm-latest", id: "accounts/fireworks/routers/glm-latest" },
    ];
    assert.deepEqual(registerableModelIds(catalog), ["auto", "accounts/fireworks/routers/glm-latest"]);
  });
});

