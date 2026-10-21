import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFireworksSettings } from "../../../lib/harnesses/claude/core.mjs";
import {
  assertClaudeModelOverrides,
  resolveClaudeModelMapping,
} from "../../../lib/harnesses/claude/model-profile.mjs";
import {
  CLAUDE_NATIVE_MODEL_ID,
  CLAUDE_NATIVE_SLOT_ALIAS,
  isAnthropicModelId,
  isClaudeNativeModel,
  normalizeModelId,
} from "../../../lib/fireworks/model-id.mjs";
import { isModelIdValidationApplicable } from "../../../lib/fireworks/model-servability.mjs";

const FW_KEY = "fw_test_claude_key_00000000000000";

const SENTINEL_SPELLINGS = [
  "claude-default",
  "CLAUDE-DEFAULT",
  "Claude-Default",
  "claude-default[1m]",
  "CLAUDE-DEFAULT[1m]",
  "accounts/fireworks/models/claude-default",
];

function settingsFor(overrides) {
  const { settings } = buildFireworksSettings({ env: {} }, {
    apiKey: FW_KEY,
    mapping: resolveClaudeModelMapping(overrides),
  });
  return settings;
}

describe("Claude native slot sentinel is not user input", () => {
  for (const spelling of SENTINEL_SPELLINGS) {
    it(`rejects --model ${spelling}`, () => {
      assert.throws(
        () => assertClaudeModelOverrides({ main: spelling }),
        (error) => {
          assert.match(error.message, /is not a Fireworks model id/);
          assert.ok(
            error.message.includes("--model"),
            `expected --model guidance, got: ${error.message}`,
          );
          return true;
        },
      );
    });
  }

  it("accepts the documented native alias for --model", () => {
    assert.doesNotThrow(() => assertClaudeModelOverrides({ main: "native" }));
  });

  for (const spelling of SENTINEL_SPELLINGS) {
    it(`rejects --sonnet ${spelling} with native guidance`, () => {
      assert.throws(
        () => assertClaudeModelOverrides({ sonnet: spelling }),
        (error) => {
          assert.match(error.message, /--sonnet/);
          assert.match(error.message, /`--sonnet native`/);
          return true;
        },
      );
    });
  }

  it("accepts the documented native alias for tier slots", () => {
    assert.doesNotThrow(() => assertClaudeModelOverrides({
      opus: "native",
      sonnet: "native",
      haiku: "native",
      fable: "native",
      subagent: "native",
    }));
  });

  it("accepts concrete Fireworks ids for tier slots", () => {
    assert.doesNotThrow(() => assertClaudeModelOverrides({
      sonnet: "deepseek-flash-latest",
      subagent: "glm-latest",
    }));
  });

  it("accepts concrete Fireworks ids for --model", () => {
    assert.doesNotThrow(() => assertClaudeModelOverrides({
      main: "kimi-fast-latest",
    }));
  });

  it("ignores unset --model", () => {
    assert.doesNotThrow(() => assertClaudeModelOverrides({}));
    assert.doesNotThrow(() => assertClaudeModelOverrides({ main: "" }));
  });

  it("leaves bare claude to catalog validation", () => {
    assert.equal(isClaudeNativeModel("claude"), false);
    assert.equal(isAnthropicModelId("claude"), false);
    assert.equal(isModelIdValidationApplicable("claude"), true);
    assert.doesNotThrow(() => assertClaudeModelOverrides({ main: "claude" }));
  });
});

describe("Claude native slot sentinel canonicalization", () => {
  for (const spelling of [...SENTINEL_SPELLINGS, "native", "NATIVE", " native "]) {
    it(`normalizes ${JSON.stringify(spelling)} to the sentinel`, () => {
      const normalized = normalizeModelId(spelling);
      assert.equal(normalized, CLAUDE_NATIVE_MODEL_ID);
      assert.equal(isClaudeNativeModel(normalized), true);
      assert.equal(isAnthropicModelId(normalized), false);
    });

    it(`pins the auto default for ${JSON.stringify(spelling)}`, () => {
      // No servable selection → auto is the default main.
      assert.equal(settingsFor({ main: spelling }).model, "auto[1m]");
    });

    it(`writes no sonnet pin for ${JSON.stringify(spelling)}`, () => {
      const { env } = settingsFor({ sonnet: spelling });
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, undefined);
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION, undefined);
    });

    it(`never leaks the sentinel into settings for ${JSON.stringify(spelling)}`, () => {
      const settings = settingsFor(
        Object.fromEntries(["main", "opus", "sonnet", "haiku", "fable", "subagent"].map((slot) => [slot, spelling])),
      );
      assert.doesNotMatch(JSON.stringify(settings), /claude-default/i);
    });
  }

  it("still pins concrete Anthropic model ids", () => {
    assert.equal(isAnthropicModelId("claude-sonnet-4-5"), true);
    const { env } = settingsFor({ sonnet: "claude-sonnet-4-5" });
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-4-5");
  });

  it("tags concrete Anthropic ids that do ship 1M context", () => {
    const { env } = settingsFor({ sonnet: "claude-sonnet-5" });
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-5[1m]");
  });

  it("pins the auto default for standard Fireworks keys", () => {
    const settings = settingsFor({});
    assert.equal(settings.model, "auto[1m]");
  });

  it("keeps an existing FireConnect picker on on", () => {
    const { settings } = buildFireworksSettings({
      env: {},
      modelPicker: {
        fireconnectManaged: true,
        replaceBuiltInOptions: false,
        options: [{ model: "auto[1m]", label: "Auto", description: "x" }],
      },
    }, {
      apiKey: FW_KEY,
      mapping: resolveClaudeModelMapping({}),
    });
    assert.deepEqual(
      settings.modelPicker.options.map((row) => row.model),
      ["auto[1m]"],
    );
  });

  it("clears a sentinel pin left behind by an earlier install", () => {
    const { settings } = buildFireworksSettings({
      model: "CLAUDE-DEFAULT[1m]",
      env: {
        ANTHROPIC_DEFAULT_SONNET_MODEL: "CLAUDE-DEFAULT[1m]",
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "CLAUDE DEFAULT",
      },
    }, {
      apiKey: FW_KEY,
      mapping: resolveClaudeModelMapping({ sonnet: "native" }),
    });
    assert.equal(settings.model, "auto[1m]", "sentinel pin replaced by the auto default");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, undefined);
  });
});

describe("buildFireworksSettings modelPicker writes", () => {
  const registerable = ["firerouter", "glm-latest", "auto"];

  it("appends missing rows to a picker without the FireConnect marker", () => {
    const { settings } = buildFireworksSettings({
      modelPicker: {
        replaceBuiltInOptions: false,
        options: [{ model: "firerouter[1m]", label: "FireRouter" }],
      },
      env: {},
    }, {
      apiKey: FW_KEY,
      registerablePickerIds: registerable,
    });
    assert.deepEqual(
      settings.modelPicker.options.map((row) => row.model),
      ["firerouter[1m]", "glm-latest[1m]", "auto[1m]"],
    );
  });

  it("preserves user rows while appending missing FireConnect rows", () => {
    const userPicker = {
      replaceBuiltInOptions: true,
      options: [{ model: "claude-sonnet-4-6", label: "Mine" }],
    };
    const { settings } = buildFireworksSettings({
      modelPicker: userPicker,
      env: {},
    }, {
      apiKey: FW_KEY,
      registerablePickerIds: registerable,
    });
    assert.deepEqual(
      settings.modelPicker.options.map((row) => row.model),
      ["claude-sonnet-4-6", "firerouter[1m]", "glm-latest[1m]", "auto[1m]"],
    );
    assert.deepEqual(userPicker.options, [{ model: "claude-sonnet-4-6", label: "Mine" }]);
  });

  it("creates a managed picker on a clean enable and dedupes repeats", () => {
    const first = buildFireworksSettings({ env: {} }, {
      apiKey: FW_KEY,
      registerablePickerIds: registerable,
    });
    assert.ok(first.settings.modelPicker.fireconnectManaged === true);
    // Re-running on with the same ids adds nothing.
    const second = buildFireworksSettings(first.settings, {
      apiKey: FW_KEY,
      registerablePickerIds: registerable,
    });
    assert.deepEqual(
      second.settings.modelPicker.options,
      first.settings.modelPicker.options,
    );
  });
});
