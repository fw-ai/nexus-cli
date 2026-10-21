import {
  assertNotFirerouterModelId,
  canonicalRequestedModelId,
  isClaudeNativeModel,
  isClaudeNativeSlotAlias,
  isFirerouterModel,
  normalizeModelId,
} from "../../fireworks/model-id.mjs";

const SLOT_FLAG_NAMES = Object.freeze({
  opus: "--opus",
  sonnet: "--sonnet",
  haiku: "--haiku",
  fable: "--fable",
  subagent: "--subagent",
});

export const CLAUDE_TIER_SLOTS = Object.freeze(Object.keys(SLOT_FLAG_NAMES));

/**
 * Normalized tier-slot overrides from CLI flags (`--opus` … `--subagent`).
 * Empty flags are omitted; `native` normalizes to the native sentinel so it
 * explicitly unpins a slot saved by an earlier `on`. `--model` is intentionally
 * excluded: it only adds a Fireworks row to the /model picker, never a pin.
 * @param {{ opus?: string, sonnet?: string, haiku?: string, fable?: string, subagent?: string }} ctx
 * @returns {Record<string, string>}
 */
export function claudeSlotOverridesFromCtx(ctx) {
  const overrides = {};
  for (const slot of CLAUDE_TIER_SLOTS) {
    const raw = ctx[slot]?.trim();
    if (!raw) {
      continue;
    }
    assertNotFirerouterModelId(raw, SLOT_FLAG_NAMES[slot]);
    overrides[slot] = normalizeModelId(raw);
  }
  return overrides;
}

/** Whether any tier-slot flag (`--opus` … `--subagent`) was passed. */
export function hasClaudeSlotOverrides(ctx) {
  return CLAUDE_TIER_SLOTS.some((slot) => Boolean(ctx[slot]?.trim()));
}

/**
 * @param {{ main?: string }} ctx
 * @returns {string | null} normalized model id, or null when unset / native
 */
export function claudeExtraPickerModelFromCtx(ctx) {
  const raw = ctx.main?.trim();
  if (!raw || isClaudeNativeSlotAlias(raw)) {
    return null;
  }
  const normalized = canonicalRequestedModelId(raw);
  if (isClaudeNativeModel(normalized)) {
    return null;
  }
  return normalized;
}

/** Bare `firerouter` via `--model firerouter` enables FireRouter routing headers. */
export function claudeBareFirerouterRequested(extraPickerModel) {
  return Boolean(extraPickerModel && isFirerouterModel(extraPickerModel));
}
