import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  buildFireworksSettings,
  mappingFromSettings,
  modelEnvFromMapping,
} from "../../../lib/harnesses/claude/core.mjs";
import { resolveClaudeModelMapping } from "../../../lib/harnesses/claude/model-profile.mjs";
import { firerouterStatusFromEnv, stripFirerouterOwnedEnv } from "../../../lib/firerouter/core.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel } from "../../helpers.mjs";

const FW_KEY = "fw_test_claude_key_00000000000000";

// Alias routers resolve only through the API's per-row `aliases` field now, so
// seed the targets these 1M-context assertions depend on.
before(() => {
  setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
    mockServerlessModel({
      name: "accounts/fireworks/models/glm-5p3",
      displayName: "GLM 5.3",
      aliases: ["accounts/fireworks/routers/glm-latest"],
    }),
    mockServerlessModel({
      name: "accounts/fireworks/models/kimi-k3",
      displayName: "Kimi K3",
      input_modalities: ["text", "image"],
      aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
    }),
    mockServerlessModel({
      name: "accounts/fireworks/models/deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      aliases: ["accounts/fireworks/routers/deepseek-flash-latest"],
    }),
    mockServerlessModel({
      name: "accounts/fireworks/models/glm-5p3-flash",
      displayName: "GLM 5.3 Flash",
      input_modalities: ["text", "image"],
      aliases: ["accounts/fireworks/routers/glm-flash-latest"],
    }),
  ]));
});

/*
 * `CLAUDE_CODE_SUBAGENT_MODEL` used to be written without the `[1m]` tag every
 * other slot gets, on the theory that Claude Code forwarded the subagent id to
 * the provider verbatim and Fireworks would reject "deepseek-flash-latest[1m]".
 * It doesn't: Claude Code consumes the tag to size the context window and sends
 * the bare id on the wire, the same as for the ANTHROPIC_DEFAULT_* slots.
 * Verified against Claude Code 2.0.30 through 2.1.252 by pointing the real
 * binary at a recording endpoint — the subagent request carries model
 * "deepseek-flash-latest" plus the context-1m-2025-08-07 beta either way.
 *
 * Dropping the tag is not free. Claude Code sizes an unrecognized model at the
 * window it assumes (200K) rather than the 1M the server serves, and since
 * 2.1.250 auto-compact holds the session to that assumption instead of waiting
 * for the API to object — so a tagless 1M subagent compacts until it dies.
 */
function settingsFor(overrides) {
  const { settings } = buildFireworksSettings({ env: {} }, {
    apiKey: FW_KEY,
    mapping: resolveClaudeModelMapping(overrides),
  });
  return settings;
}

describe("Claude subagent slot carries the 1M context tag", () => {
  it("tags explicit pinned slots with the 1M context suffix", () => {
    const { env } = settingsFor({
      opus: "glm-latest",
      sonnet: "kimi-fast-latest",
      haiku: "deepseek-flash-latest",
      fable: "glm-flash-latest",
      subagent: "kimi-fast-latest",
    });
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "kimi-fast-latest[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-flash-latest[1m]");
  });

  it("tags every 1M slot identically, subagent included", () => {
    const env = modelEnvFromMapping({
      opus: "glm-latest",
      sonnet: "kimi-fast-latest",
      haiku: "deepseek-flash-latest",
      fable: "glm-flash-latest",
      subagent: "kimi-fast-latest",
    });
    assert.deepEqual(env, {
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-latest[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-fast-latest[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash-latest[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "glm-flash-latest[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-fast-latest[1m]",
    });
  });

  it("rejects a FireRouter subagent at admission, but still recognizes a stored one as FireRouter-owned", () => {
    // New selections: resolveClaudeModelMapping is the admission gate.
    assert.throws(
      () => resolveClaudeModelMapping({ subagent: "firerouter" }),
      /is a FireRouter route, which is no longer supported/,
    );
    // Legacy configs an earlier release wrote are still recognized (and
    // stripped) as FireRouter-owned.
    const env = modelEnvFromMapping({ subagent: "firerouter" });
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "firerouter[1m]");
    assert.equal(firerouterStatusFromEnv(env), "firerouter");
    const { env: stripped } = stripFirerouterOwnedEnv(env);
    assert.equal(Object.hasOwn(stripped, "CLAUDE_CODE_SUBAGENT_MODEL"), false);
  });

  it("leaves a sub-1M subagent model untagged", () => {
    const { env } = settingsFor({ subagent: "kimi-k2p6" });
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "kimi-k2p6");
  });

  it("pins nothing when the subagent slot is native", () => {
    const { env } = settingsFor({ subagent: "native" });
    assert.equal(Object.hasOwn(env, "CLAUDE_CODE_SUBAGENT_MODEL"), false);
  });

  it("reads native defaults back from an empty fireworks mapping", () => {
    const settings = settingsFor({});
    assert.equal(mappingFromSettings(settings).subagent, "claude-default");
  });
});
