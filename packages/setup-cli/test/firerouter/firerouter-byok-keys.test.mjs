import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_BYOK_HEADER,
  OPENAI_BYOK_HEADER,
  buildClaudeCustomHeaders,
  byokEnvFromHeaders,
  firerouterByokHeaders,
  isAnthropicShapedKey,
  isOpenAIShapedKey,
  openaiKeyFromCustomHeaders,
  resolveOpenaiKey,
} from "../../lib/firerouter/core.mjs";
import {
  resolveFirerouterByokHeaders,
  resolveFirerouterPlan,
  supportsOpenaiApiKeyFlag,
} from "../../lib/firerouter/flag.mjs";
import { firerouterRequiresOpenaiKey } from "../../lib/fireworks/model-id.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";

function clearProviderKeys() {
  const saved = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  return () => {
    if (saved.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = saved.anthropic;
    if (saved.openai !== undefined) process.env.OPENAI_API_KEY = saved.openai;
  };
}

describe("firerouter provider key shapes", () => {
  it("keeps the Anthropic and OpenAI families disjoint", () => {
    assert.equal(isAnthropicShapedKey("sk-ant-123"), true);
    assert.equal(isOpenAIShapedKey("sk-ant-123"), false);
    for (const key of ["sk-proj-abc", "sk-openai-abc", "sk-abc"]) {
      assert.equal(isOpenAIShapedKey(key), true, key);
      assert.equal(isAnthropicShapedKey(key), false, key);
    }
    for (const key of ["", "fw_test", "fpk_test", "Bearer x", undefined, null]) {
      assert.equal(isOpenAIShapedKey(key), false, String(key));
      assert.equal(isAnthropicShapedKey(key), false, String(key));
    }
  });

  it("detects OpenAI members in firerouter routes only", () => {
    assert.equal(firerouterRequiresOpenaiKey("firerouter/gpt-5p6"), true);
    assert.equal(firerouterRequiresOpenaiKey("firerouter/openai/gpt-5p6"), true);
    assert.equal(firerouterRequiresOpenaiKey("firerouter/o3"), true);
    assert.equal(firerouterRequiresOpenaiKey("firerouter/o4-mini"), true);
    assert.equal(firerouterRequiresOpenaiKey("firerouter"), false);
    assert.equal(firerouterRequiresOpenaiKey("firerouter/opus"), false);
    assert.equal(firerouterRequiresOpenaiKey("firerouter/sol"), false);
    assert.equal(firerouterRequiresOpenaiKey("firerouter/kimi-k3"), false);
    assert.equal(firerouterRequiresOpenaiKey("kimi-k3"), false);
    assert.equal(firerouterRequiresOpenaiKey(""), false);
  });

  it("resolveFirerouterPlan reports both provider requirements", () => {
    assert.deepEqual(resolveFirerouterPlan({ main: "firerouter" }), {
      mainModel: "firerouter",
      isFirerouter: true,
      requiresAnthropicKey: true,
      requiresOpenaiKey: false,
      namesAnthropicModel: false,
    });
    const opus = resolveFirerouterPlan({ main: "firerouter/opus" });
    assert.equal(opus.requiresAnthropicKey, true);
    assert.equal(opus.requiresOpenaiKey, false);
    const gpt = resolveFirerouterPlan({ main: "firerouter/gpt-5p6" });
    assert.equal(gpt.isFirerouter, true);
    assert.equal(gpt.requiresOpenaiKey, true);
  });
});

describe("firerouter openai key resolution", () => {
  it("extracts the OpenAI key from custom headers without touching the Anthropic line", () => {
    const headers = [
      "X-Fireworks-Api-Key: fw_test",
      `${ANTHROPIC_BYOK_HEADER}: sk-ant-123`,
      `${OPENAI_BYOK_HEADER}: sk-proj-123`,
    ].join("\n");
    assert.equal(openaiKeyFromCustomHeaders(headers), "sk-proj-123");
    assert.equal(openaiKeyFromCustomHeaders(""), "");
  });

  it("byokEnvFromHeaders round-trips both provider headers", () => {
    assert.deepEqual(
      byokEnvFromHeaders({
        [ANTHROPIC_BYOK_HEADER]: "sk-ant-h",
        [OPENAI_BYOK_HEADER]: "sk-proj-h",
      }),
      {
        ANTHROPIC_CUSTOM_HEADERS: `${ANTHROPIC_BYOK_HEADER}: sk-ant-h`,
        [OPENAI_BYOK_HEADER]: "sk-proj-h",
      },
    );
    assert.deepEqual(byokEnvFromHeaders({}), {});
  });

  it("resolves flag over global over env over stored header, rejecting mislabeled keys", async () => {
    const restore = clearProviderKeys();
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-openai-resolve-"));
      await writeGlobalConfig(home, { openaiApiKey: "sk-proj-from-global", harnesses: {} });
      process.env.OPENAI_API_KEY = "sk-proj-from-env";

      assert.equal(await resolveOpenaiKey({ home }), "sk-proj-from-global");
      assert.equal(
        await resolveOpenaiKey({ apiKey: "sk-proj-from-flag", home }),
        "sk-proj-from-flag",
      );
      // A mislabeled Anthropic key never seats the OpenAI credential.
      assert.equal(
        await resolveOpenaiKey({ apiKey: "sk-ant-mislabeled", home }),
        "sk-proj-from-global",
      );
      assert.equal(await resolveOpenaiKey({}), "sk-proj-from-env");
      delete process.env.OPENAI_API_KEY;
      const headerKey = await resolveOpenaiKey({
        settingsEnv: byokEnvFromHeaders({ [OPENAI_BYOK_HEADER]: "sk-proj-from-header" }),
      });
      assert.equal(headerKey, "sk-proj-from-header");
      assert.equal(await resolveOpenaiKey({}), "");
    } finally {
      restore();
    }
  });
});

describe("firerouter byok header wiring", () => {
  it("builds value headers for each configured key, omitting missing ones", () => {
    assert.deepEqual(
      firerouterByokHeaders({ anthropicKey: "sk-ant-a", openaiKey: "sk-proj-o" }),
      { [ANTHROPIC_BYOK_HEADER]: "sk-ant-a", [OPENAI_BYOK_HEADER]: "sk-proj-o" },
    );
    assert.deepEqual(firerouterByokHeaders({}), {});
    assert.deepEqual(firerouterByokHeaders({ anthropicKey: "  " }), {});
  });

  it("writes the OpenAI line into Claude custom headers only when configured", () => {
    assert.equal(
      buildClaudeCustomHeaders({ fireworksKey: "fw_test", openaiKey: "sk-proj-o" }),
      `X-Fireworks-Api-Key: fw_test\n${OPENAI_BYOK_HEADER}: sk-proj-o`,
    );
    assert.equal(
      buildClaudeCustomHeaders({ fireworksKey: "fw_test" }),
      "X-Fireworks-Api-Key: fw_test",
    );
  });

  it("attaches a configured OpenAI key on bare firerouter without requiring one", async () => {
    const restore = clearProviderKeys();
    try {
      process.env.OPENAI_API_KEY = "sk-proj-env-123";
      const plan = resolveFirerouterPlan({ main: "firerouter" });
      const headers = await resolveFirerouterByokHeaders({
        plan,
        ctx: { home: "" },
        preResolvedAnthropicKey: "",
      });
      assert.equal(headers[OPENAI_BYOK_HEADER], "sk-proj-env-123");
      assert.equal(ANTHROPIC_BYOK_HEADER in headers, false);
    } finally {
      restore();
    }
  });

  it("attaches a configured Anthropic key on firerouter/opus", async () => {
    const restore = clearProviderKeys();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-env-123";
      const plan = resolveFirerouterPlan({ main: "firerouter/opus" });
      assert.equal(plan.requiresAnthropicKey, true);
      const headers = await resolveFirerouterByokHeaders({ plan, ctx: { home: "" } });
      assert.equal(headers[ANTHROPIC_BYOK_HEADER], "sk-ant-env-123");
      assert.equal(OPENAI_BYOK_HEADER in headers, false);
    } finally {
      restore();
    }
  });

  it("attaches nothing when neither key is configured instead of failing", async () => {
    const restore = clearProviderKeys();
    try {
      const plan = resolveFirerouterPlan({ main: "firerouter/opus" });
      const headers = await resolveFirerouterByokHeaders({
        plan,
        ctx: { home: "" },
        preResolvedAnthropicKey: "",
      });
      assert.deepEqual(headers, {});
    } finally {
      restore();
    }
  });

  it("leaves pinned non-GPT compounds clean even with an OpenAI key configured", async () => {
    const restore = clearProviderKeys();
    try {
      process.env.OPENAI_API_KEY = "sk-proj-env-123";
      for (const model of ["firerouter/kimi-k3", "firerouter/sol", "firerouter/opus"]) {
        const plan = resolveFirerouterPlan({ main: model });
        const headers = await resolveFirerouterByokHeaders({
          plan,
          ctx: { home: "" },
          preResolvedAnthropicKey: "",
        });
        assert.deepEqual(headers, {}, model);
      }
    } finally {
      restore();
    }
  });

  it("supportsOpenaiApiKeyFlag mirrors harness forwarding ability", () => {
    assert.equal(supportsOpenaiApiKeyFlag({ byok: "value" }), true);
    assert.equal(supportsOpenaiApiKeyFlag({ byok: "none", customHeaderOpenaiKey: true }), true);
    assert.equal(supportsOpenaiApiKeyFlag({ byok: "none" }), false);
    assert.equal(supportsOpenaiApiKeyFlag(null), false);
  });
});
