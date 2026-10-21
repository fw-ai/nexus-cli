import {
  AUTO_MODEL_ID,
  CLAUDE_NATIVE_MODEL_ID,
  CLAUDE_NATIVE_SLOT_ALIAS,
  firerouterRequiresOpenaiKey,
  fireworksModelSlug,
  isClaudeNativeModel,
  isClaudeNativeSlotAlias,
  isFirerouterModel,
  isFirerouterModelPattern,
  isRetiredModelId,
  normalizeModelId,
  validateModelId,
} from "../../fireworks/model-id.mjs";

export const CLAUDE_MODEL_SLOTS = Object.freeze([
  "main",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "subagent",
]);

const PROFILE_VERSION = 1;
// Saved profiles live under a key-type envelope; entries written for other key
// types by older releases are ignored.
const PROFILE_KEY = "fireworks";

export function defaultClaudeModelMapping() {
  // Main is never pinned: Claude Code resolves an unset main through the
  // account-default alias (Opus/Sonnet), which the slots below already remap.
  // Pinning it would write settings.model and shadow the `/model` picker.
  return Object.fromEntries(
    CLAUDE_MODEL_SLOTS.map((slot) => [slot, CLAUDE_NATIVE_MODEL_ID]),
  );
}

/**
 * Pinned model slugs from older FireConnect defaults that should be rewritten to
 * their stable `-latest` router alias when an existing Claude Code install is
 * re-`on`ed. The writer re-applies the Claude Code `[1m]` context tag per slot,
 * so entries map bare slug -> bare router alias (e.g. deepseek-v4-flash ->
 * deepseek-flash-latest, which the writer serves as deepseek-flash-latest[1m]).
 */
const LEGACY_CLAUDE_MODEL_MIGRATIONS = Object.freeze({
  "deepseek-v4-flash": "deepseek-flash-latest",
});

/**
 * Rewrite any slot whose model slug is a legacy pinned default to its `-latest`
 * router alias, and any FireRouter pin to the `auto` mix. Used on the persisted
 * (saved profile / live settings) mapping during activation so an existing
 * `claude on` install is migrated to the current routing; explicit per-run CLI
 * overrides are merged afterward and are not migrated.
 * @param {Record<string, string>} mapping
 * @returns {{ mapping: Record<string, string>, changed: boolean }}
 */
export function migrateLegacyClaudeModelMapping(mapping = {}) {
  const next = {};
  let changed = false;
  for (const [slot, modelId] of Object.entries(mapping)) {
    if (typeof modelId !== "string" || !modelId.trim()) {
      next[slot] = modelId;
      continue;
    }
    // Retired pins carried over from an earlier `on` (FireRouter routes,
    // `auto-instant`) drop to the `auto` mix; explicit slot flags are
    // merged after this and win.
    const target = isRetiredModelId(modelId)
      ? AUTO_MODEL_ID
      : LEGACY_CLAUDE_MODEL_MIGRATIONS[fireworksModelSlug(modelId)];
    if (target) {
      next[slot] = target;
      changed = true;
    } else {
      next[slot] = modelId;
    }
  }
  return { mapping: next, changed };
}

/** Merge model sources from lowest to highest precedence. */
export function mergeClaudeModelMappings(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const slot of CLAUDE_MODEL_SLOTS) {
      if (typeof source?.[slot] === "string" && source[slot].trim()) {
        merged[slot] = source[slot].trim();
      }
    }
  }
  return merged;
}

const CLAUDE_SLOT_FLAGS = Object.freeze({
  main: "--model",
  opus: "--opus",
  sonnet: "--sonnet",
  haiku: "--haiku",
  fable: "--fable",
  subagent: "--subagent",
});

/**
 * Reject Nexus's internal unpinned-slot sentinel when it arrives as a
 * user-supplied slot value. `claude-default` names nothing Claude Code or the
 * gateway can serve — inside Nexus it only means "write no pin" — so
 * accepting it as input is how it ends up back in settings.json as a model id.
 * `native` is the spelling users are given for that intent.
 *
 * Persisted state is deliberately not checked here: a saved profile or a
 * settings file written by an older release legitimately carries the sentinel,
 * and {@link resolveClaudeModelMapping} canonicalizes those instead of failing.
 */
export function assertClaudeModelOverrides(ctx) {
  const value = ctx.main?.trim();
  if (value && !isClaudeNativeSlotAlias(value) && isClaudeNativeModel(normalizeModelId(value))) {
    throw new Error(
      `--model ${value} is not a Fireworks model id. Tier slots stay on Claude defaults; `
        + `\`--model\` chooses a serverless model and adds it to the /model picker.`,
    );
  }
  for (const [slot, flag] of Object.entries(CLAUDE_SLOT_FLAGS)) {
    if (slot === "main") {
      continue;
    }
    const raw = ctx[slot]?.trim();
    if (!raw || isClaudeNativeSlotAlias(raw)) {
      continue;
    }
    if (isClaudeNativeModel(normalizeModelId(raw))) {
      throw new Error(
        `${flag} ${raw} is not a model id. Use \`${flag} ${CLAUDE_NATIVE_SLOT_ALIAS}\` `
          + "to leave the slot on Claude Code's own default model.",
      );
    }
  }
}

export function resolveClaudeModelMapping(overrides = {}) {
  const selected = mergeClaudeModelMappings(
    defaultClaudeModelMapping(),
    overrides,
  );
  for (const [slot, flag] of Object.entries(CLAUDE_SLOT_FLAGS)) {
    selected[slot] = normalizeModelId(selected[slot]);
    validateModelId(selected[slot], flag);
  }
  return selected;
}

/**
 * Whether any Claude slot pins the bare `firerouter` model. The routing
 * preference is only honored there — not for `auto` or `firerouter/*`
 * compounds, which pin their own targets.
 */
export function mappingUsesBareFirerouter(mapping) {
  return Object.values(mapping).some((modelId) => isFirerouterModel(modelId));
}

/**
 * Whether a configured OpenAI key should ride along as `x-openai-api-key`:
 * bare `firerouter` anywhere (its mix can serve GPT primaries), or a GPT
 * compound like `firerouter/gpt-...` as the /model default or pinned to any
 * tier slot (saved or flagged). Pinned non-GPT compounds stay clean. Mirrors
 * `needsOpenaiKey` in `SlotMapping.lean`.
 * @param {Record<string, string>} mapping resolved Claude slot mapping
 * @param {string|null} defaultModel the top-level /model default `on` writes
 *   (`--model`, a kept saved pick, or the implicit firerouter default)
 */
export function claudeMappingNeedsOpenaiKey(mapping, defaultModel = null) {
  return [defaultModel, ...Object.values(mapping)]
    .some((modelId) => isFirerouterModel(modelId ?? "")
      || firerouterRequiresOpenaiKey(modelId ?? ""));
}

function completeMapping(raw) {
  const mapping = mergeClaudeModelMappings(raw);
  return CLAUDE_MODEL_SLOTS.every((slot) => Boolean(mapping[slot]))
    ? mapping
    : null;
}

/**
 * Normalize the persisted, key-scoped Claude profile envelope.
 * Invalid/legacy entries are ignored because this schema has not shipped.
 */
export function normalizeClaudeProfiles(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const profile = raw[PROFILE_KEY];
  const models = profile?.version === PROFILE_VERSION
    ? completeMapping(profile.models)
    : null;
  return models ? { [PROFILE_KEY]: { version: PROFILE_VERSION, models } } : {};
}

export function savedClaudeModelMapping(profiles) {
  return normalizeClaudeProfiles(profiles)[PROFILE_KEY]?.models ?? {};
}

// A native-Claude slot is persisted as the sentinel but read live as null/unset.
// Treat the two as equal when matching a live mapping against saved profiles.
function claudeSlotValuesMatch(left, right) {
  const norm = (value) => (value == null ? CLAUDE_NATIVE_MODEL_ID : value);
  return norm(left) === norm(right);
}

/**
 * Whether the live settings mapping was written for the current Fireworks key
 * and may be carried into the next `on`. A legacy Fire Pass setup never is; a
 * Fireworks token or recorded key type settles it; otherwise the live mapping
 * must match most of the saved profile. Installs with no saved profile predate
 * scope metadata and are trusted.
 */
export function claudeActiveMappingIsCurrent({
  legacyFirePass = false,
  tokenIsFireworks = false,
  recordedKeyType = "",
  profiles = {},
  activeMapping = {},
}) {
  if (legacyFirePass) return false;
  if (tokenIsFireworks || recordedKeyType === PROFILE_KEY) return true;
  const saved = normalizeClaudeProfiles(profiles)[PROFILE_KEY]?.models;
  if (!saved) return true;
  const matches = CLAUDE_MODEL_SLOTS.filter(
    (slot) => claudeSlotValuesMatch(saved[slot], activeMapping[slot]),
  ).length;
  return matches >= Math.ceil(CLAUDE_MODEL_SLOTS.length * 2 / 3);
}

export function withSavedClaudeModelMapping(profiles, mapping) {
  const models = completeMapping(mapping);
  if (!models) {
    throw new Error("Cannot persist an incomplete Claude model profile");
  }
  return {
    ...normalizeClaudeProfiles(profiles),
    [PROFILE_KEY]: {
      version: PROFILE_VERSION,
      models,
    },
  };
}
