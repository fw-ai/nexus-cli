import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveClaudeActivationPlan,
} from "../../../lib/harnesses/claude/activation.mjs";
import {
  CLAUDE_MODEL_SLOTS,
  claudeActiveMappingIsCurrent,
  defaultClaudeModelMapping,
  mappingUsesBareFirerouter,
  migrateLegacyClaudeModelMapping,
  normalizeClaudeProfiles,
  savedClaudeModelMapping,
  withSavedClaudeModelMapping,
} from "../../../lib/harnesses/claude/model-profile.mjs";
import {
  claudeExtraPickerModelFromCtx,
} from "../../../lib/harnesses/claude/connect.mjs";
import { CLAUDE_NATIVE_MODEL_ID } from "../../../lib/fireworks/model-id.mjs";

const EMPTY_OVERRIDES = {
  main: "",
  opus: "",
  sonnet: "",
  haiku: "",
  fable: "",
  subagent: "",
};

describe("Claude model profiles", () => {
  it("stores a complete mapping under the fireworks envelope", () => {
    const mapping = { ...defaultClaudeModelMapping(), opus: "glm-latest" };
    const profiles = withSavedClaudeModelMapping({}, mapping);

    assert.deepEqual(Object.keys(profiles), ["fireworks"]);
    assert.deepEqual(savedClaudeModelMapping(profiles), mapping);
  });

  it("ignores legacy, incomplete, and malformed profile entries", () => {
    assert.deepEqual(normalizeClaudeProfiles({
      models: defaultClaudeModelMapping(),
      fireworks: { version: 1, models: { main: "glm-latest" } },
    }), {});
    assert.deepEqual(normalizeClaudeProfiles({
      fireworks: { version: 99, models: defaultClaudeModelMapping() },
    }), {});
  });

  it("ignores a legacy firepass profile entry in the persisted envelope", () => {
    const fireworks = { ...defaultClaudeModelMapping(), opus: "glm-latest" };
    const legacyFirepass = Object.fromEntries(
      CLAUDE_MODEL_SLOTS.map((slot) => [slot, "kimi-fast-latest"]),
    );
    assert.deepEqual(normalizeClaudeProfiles({
      firepass: { version: 1, models: legacyFirepass },
    }), {});
    assert.deepEqual(normalizeClaudeProfiles({
      fireworks: { version: 1, models: fireworks },
      firepass: { version: 1, models: legacyFirepass },
    }), { fireworks: { version: 1, models: fireworks } });
    assert.deepEqual(savedClaudeModelMapping({
      firepass: { version: 1, models: legacyFirepass },
    }), {});
  });

  it("ignores an active mapping that is not current", () => {
    const saved = { ...defaultClaudeModelMapping(), opus: "glm-latest" };
    const profiles = withSavedClaudeModelMapping({}, saved);
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      activeMappingIsCurrent: false,
      snapshot: {
        profiles,
        intent: {
          mapping: { ...defaultClaudeModelMapping(), sonnet: "deepseek-pro-latest" },
        },
      },
    });

    assert.deepEqual(plan.mapping, saved);
  });

  it("treats a Fireworks token or recorded fireworks key type as current", () => {
    const profiles = withSavedClaudeModelMapping({}, {
      ...defaultClaudeModelMapping(),
      opus: "glm-latest",
    });
    const unrelated = Object.fromEntries(
      CLAUDE_MODEL_SLOTS.map((slot) => [slot, "kimi-fast-latest"]),
    );
    assert.equal(claudeActiveMappingIsCurrent({
      tokenIsFireworks: true,
      profiles,
      activeMapping: unrelated,
    }), true);
    assert.equal(claudeActiveMappingIsCurrent({
      recordedKeyType: "fireworks",
      profiles,
      activeMapping: unrelated,
    }), true);
    assert.equal(claudeActiveMappingIsCurrent({
      recordedKeyType: "firepass",
      profiles,
      activeMapping: unrelated,
    }), false);
  });

  it("never carries over a legacy Fire Pass setup's live pins", () => {
    const pins = Object.fromEntries(
      CLAUDE_MODEL_SLOTS.map((slot) => [slot, "kimi-fast-latest"]),
    );
    assert.equal(claudeActiveMappingIsCurrent({
      legacyFirePass: true,
      tokenIsFireworks: true,
      activeMapping: pins,
    }), false);
  });

  it("trusts metadata-free mappings when no profile is saved", () => {
    assert.equal(claudeActiveMappingIsCurrent({
      profiles: {},
      activeMapping: { ...defaultClaudeModelMapping(), opus: "glm-latest" },
    }), true);
    assert.equal(claudeActiveMappingIsCurrent({}), true);
  });

  it("matches a live mapping against the saved profile by slot overlap", () => {
    const saved = {
      ...defaultClaudeModelMapping(),
      opus: "glm-latest",
      sonnet: "deepseek-pro-latest",
    };
    const profiles = withSavedClaudeModelMapping({}, saved);
    const liveNative = { ...saved, main: null, haiku: undefined };
    assert.equal(claudeActiveMappingIsCurrent({
      profiles,
      activeMapping: liveNative,
    }), true);
    assert.equal(claudeActiveMappingIsCurrent({
      profiles,
      activeMapping: { ...saved, main: "kimi-fast-latest", fable: "glm-latest" },
    }), true);
    assert.equal(claudeActiveMappingIsCurrent({
      profiles,
      activeMapping: {
        ...saved,
        main: "kimi-fast-latest",
        fable: "glm-latest",
        subagent: "glm-fast-latest",
      },
    }), false);
  });

  it("preserves saved fireworks slot pins across a plain re-on", () => {
    const persisted = {
      ...defaultClaudeModelMapping(),
      opus: "glm-latest",
      sonnet: "deepseek-pro-latest",
    };
    const profiles = withSavedClaudeModelMapping({}, persisted);
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      activeMappingIsCurrent: true,
      snapshot: { profiles, intent: { mapping: persisted } },
    });
    assert.equal(plan.mapping.opus, "glm-latest");
    assert.equal(plan.mapping.sonnet, "deepseek-pro-latest");
    assert.equal(plan.mapping.haiku, CLAUDE_NATIVE_MODEL_ID);
    assert.equal(plan.mapping.main, CLAUDE_NATIVE_MODEL_ID);
  });

  it("lets explicit slot flags win over saved pins and `native` unpin", () => {
    const persisted = {
      ...defaultClaudeModelMapping(),
      opus: "glm-latest",
      sonnet: "deepseek-pro-latest",
    };
    const profiles = withSavedClaudeModelMapping({}, persisted);
    const plan = resolveClaudeActivationPlan({
      ctx: { ...EMPTY_OVERRIDES, sonnet: "kimi-fast-latest", opus: "native" },
      activeMappingIsCurrent: true,
      snapshot: { profiles, intent: { mapping: persisted } },
    });
    assert.equal(plan.mapping.sonnet, "kimi-fast-latest");
    assert.equal(plan.mapping.opus, CLAUDE_NATIVE_MODEL_ID);
    assert.equal(plan.mapping.haiku, CLAUDE_NATIVE_MODEL_ID);
  });

  it("tracks --model as a picker addition without pinning tier slots", () => {
    const ctx = { ...EMPTY_OVERRIDES, main: "glm-latest" };
    assert.equal(claudeExtraPickerModelFromCtx(ctx), "glm-latest");
    const plan = resolveClaudeActivationPlan({
      ctx,
      activeMappingIsCurrent: true,
      snapshot: { profiles: {}, intent: null },
    });
    assert.deepEqual(plan.mapping, defaultClaudeModelMapping());
  });

  it("leaves tier slots native on first connect", () => {
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      activeMappingIsCurrent: true,
      snapshot: { profiles: {}, intent: null },
    });
    assert.equal(plan.mapping.opus, CLAUDE_NATIVE_MODEL_ID);
    assert.equal(plan.mapping.sonnet, CLAUDE_NATIVE_MODEL_ID);
  });

  it("migrates legacy pinned deepseek-v4-flash slots to the deepseek-flash-latest router alias", () => {
    // Bare slug, full accounts/fireworks ref, and [1m]-tagged forms all migrate;
    // unrelated slots pass through unchanged. The writer re-applies [1m] per
    // slot, so the migration target is the bare router alias.
    const migrated = migrateLegacyClaudeModelMapping({
      main: "kimi-fast-latest",
      opus: "accounts/fireworks/models/deepseek-v4-flash",
      sonnet: "glm-5p1",
      haiku: "deepseek-v4-flash",
      fable: "kimi-fast-latest",
      subagent: "deepseek-v4-flash[1m]",
    });
    assert.equal(migrated.changed, true);
    assert.deepEqual(migrated.mapping, {
      main: "kimi-fast-latest",
      opus: "deepseek-flash-latest",
      sonnet: "glm-5p1",
      haiku: "deepseek-flash-latest",
      fable: "kimi-fast-latest",
      subagent: "deepseek-flash-latest",
    });

    // A mapping with no legacy slugs is returned unchanged.
    const clean = migrateLegacyClaudeModelMapping(defaultClaudeModelMapping());
    assert.equal(clean.changed, false);
    assert.deepEqual(clean.mapping, defaultClaudeModelMapping());
  });

  it("migrates FireRouter slots carried over from an earlier on to auto", () => {
    const migrated = migrateLegacyClaudeModelMapping({
      main: "firerouter",
      opus: "firerouter/opus",
      sonnet: "glm-5p1",
      haiku: "accounts/fireworks/routers/firerouter",
      fable: CLAUDE_NATIVE_MODEL_ID,
      subagent: "firerouter/kimi-k3",
    });
    assert.equal(migrated.changed, true);
    assert.deepEqual(migrated.mapping, {
      main: "auto",
      opus: "auto",
      sonnet: "glm-5p1",
      haiku: "auto",
      fable: CLAUDE_NATIVE_MODEL_ID,
      subagent: "auto",
    });
  });

  it("migrates baked-in legacy slots for saved profiles", () => {
    const profiles = withSavedClaudeModelMapping({}, {
      ...defaultClaudeModelMapping(),
      haiku: "deepseek-v4-flash",
      subagent: "deepseek-v4-flash",
    });
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      activeMappingIsCurrent: true,
      snapshot: {
        profiles,
        intent: {
          mapping: {
            ...defaultClaudeModelMapping(),
            haiku: "deepseek-v4-flash",
            subagent: "deepseek-v4-flash",
          },
        },
      },
    });
    assert.equal(plan.mapping.haiku, "deepseek-flash-latest");
    assert.equal(plan.mapping.subagent, "deepseek-flash-latest");
  });

  it("scopes bare-firerouter detection to the firerouter model only", () => {
    const mapping = defaultClaudeModelMapping();
    assert.equal(mappingUsesBareFirerouter({ ...mapping, opus: "firerouter" }), true);
    assert.equal(mappingUsesBareFirerouter({ ...mapping, opus: "firerouter[1m]" }), true);
    // Compounds pin their own targets; auto routes open models only.
    assert.equal(mappingUsesBareFirerouter({ ...mapping, opus: "firerouter/kimi-k3" }), false);
    assert.equal(mappingUsesBareFirerouter({ ...mapping, opus: "auto" }), false);
    assert.equal(mappingUsesBareFirerouter(mapping), false);
  });
});
