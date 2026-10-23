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
} from "../../lib/firerouter/core.mjs";
import { supportsOpenaiApiKeyFlag } from "../../lib/firerouter/flag.mjs";
import { firerouterRequiresOpenaiKey } from "../../lib/fireworks/model-id.mjs";

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

  it("supportsOpenaiApiKeyFlag mirrors harness forwarding ability", () => {
    assert.equal(supportsOpenaiApiKeyFlag({ byok: "value" }), true);
    assert.equal(supportsOpenaiApiKeyFlag({ byok: "none", customHeaderOpenaiKey: true }), true);
    assert.equal(supportsOpenaiApiKeyFlag({ byok: "none" }), false);
    assert.equal(supportsOpenaiApiKeyFlag(null), false);
  });
});
