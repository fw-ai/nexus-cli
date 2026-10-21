/**
 * Model resolution for `nexus claude demo`.
 *
 * The demo races two real `claude -p` processes side by side using the user's
 * existing Nexus-managed Claude Code profile — same auth and gateway
 * routing as `claude live`; no isolated config dirs or credential seeding. The
 * incumbent (Anthropic slot) side is pinned to a concrete canonical Anthropic id
 * so it runs REAL Anthropic, bypassing the user's `ANTHROPIC_DEFAULT_*_MODEL`
 * slot pin (which nexus may redirect to a Fireworks backend).
 */

import { claudeCodeModelId } from "../harnesses/claude/code-context.mjs";
import { assertClaudeFireconnected } from "./demo-prep.mjs";
import {
  ANTHROPIC_SLOT_CONCRETE_IDS,
  defaultLeftModel,
  defaultRightModel,
  isAnthropicSlotModel,
} from "./demo-models.mjs";

/**
 * Resolve the `--model` value for one demo side.
 *
 * Anthropic slots (opus/sonnet/haiku/fable) resolve to their **concrete
 * canonical Anthropic id** (e.g. claude-opus-5), not the bare alias. A concrete
 * id bypasses Claude Code's `ANTHROPIC_DEFAULT_*_MODEL` alias expansion, so the
 * incumbent side runs REAL Anthropic instead of the user's nexus slot pin
 * (which may redirect opus to a Fireworks backend like firerouter). The request
 * still routes through the Fireworks AI gateway via the live `ANTHROPIC_BASE_URL`
 * + Fireworks key — the gateway serves real Anthropic models by concrete id.
 * `claudeCodeModelId` appends the `[1m]` 1M-context tag for qualifying models.
 * @param {string} modelId
 */
export function demoCliModel(modelId) {
  const bare = String(modelId).trim();
  if (isAnthropicSlotModel(bare)) {
    // isAnthropicSlotModel lowercases before matching, so the map lookup must
    // too — otherwise "Opus" passes the check, misses the map, and returns
    // undefined, which drops `--model` entirely and silently falls back to the
    // live nexus pin this mapping exists to bypass.
    return claudeCodeModelId(ANTHROPIC_SLOT_CONCRETE_IDS[bare.toLowerCase()]);
  }
  return claudeCodeModelId(bare);
}

/**
 * Resolve left/right `--model` values and require `nexus claude`.
 *
 * @param {{
 *   leftModel?: string,
 *   rightModel?: string,
 *   home?: string,
 *   settingsPath?: string,
 * }} args
 */
export async function prepareRouteSettings({
  leftModel = "",
  rightModel = "",
  home = "",
  settingsPath = "",
}) {
  await assertClaudeFireconnected({ home, settingsPath });
  const resolvedLeft = leftModel || defaultLeftModel();
  const resolvedRight = rightModel || defaultRightModel();
  return {
    leftCliModel: demoCliModel(resolvedLeft),
    rightCliModel: demoCliModel(resolvedRight),
    cleanup: async () => {},
  };
}
