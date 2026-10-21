import {
  CLAUDE_NATIVE_MODEL_ID,
  fireworksModelSlug,
  isAnthropicModelId,
  isClaudeNativeModel,
  isGatewayAnthropicSlot,
  isFirerouterModelPattern,
} from "../../fireworks/model-id.mjs";
import { lookupModelSpec, resolveFireworksCatalog } from "../../fireworks/model-specs.mjs";
import { loadServerlessCatalog } from "../../fireworks/models.mjs";

export const CLAUDE_CODE_1M_CONTEXT_THRESHOLD = 1_000_000;

const CLAUDE_CODE_1M_SUFFIX = "[1m]";

/**
 * Concrete Anthropic model ids that support Claude Code's 1M context window.
 * Per platform.claude.com/docs: Opus 5 / Sonnet 5 / Fable 5 / 5.1 ship 1M context;
 * Haiku 4.5 is 200K, so it must NOT receive the `[1m]` suffix (the tag would
 * request a context window the model doesn't have). The bare aliases (opus/
 * sonnet/haiku/fable) resolve to these via ANTHROPIC_DEFAULT_*_MODEL, and a
 * pinned slot could point at any id, so qualify on the concrete id — not the
 * blanket `isGatewayAnthropicSlot` match.
 */
const ANTHROPIC_1M_CONTEXT_IDS = new Set([
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-fable-5-1",
]);

export function stripClaudeCodeContextSuffix(modelId) {
  if (typeof modelId !== "string") {
    return modelId;
  }
  return modelId.replace(/\[1m\]$/i, "");
}

export function modelQualifiesForClaudeCode1mContext(modelId) {
  if (!modelId) {
    return false;
  }
  if (isGatewayAnthropicSlot(modelId)) {
    // Concrete Anthropic ids served on the gateway: qualify only the ones that
    // actually ship 1M context. Haiku 4.5 (200K) must NOT get the [1m] suffix.
    // The bare aliases (opus/sonnet/haiku/fable) are handled by callers mapping
    // them to a concrete id first (e.g. demoCliModel), so a bare alias reaching
    // here is treated as qualifying (it expands to a 1M model by default).
    const bare = stripClaudeCodeContextSuffix(modelId).toLowerCase();
    if (bare === CLAUDE_NATIVE_MODEL_ID) {
      // The native sentinel means "let Claude pick its own default", and those
      // defaults (Opus 5 / Sonnet 5) DO have 1M context. It must therefore
      // qualify here, because applyClaudeCodeContextPolicy uses this predicate to
      // decide whether to set CLAUDE_CODE_DISABLE_1M_CONTEXT — answering "no"
      // would switch 1M off for an all-native mapping. The separate question of
      // whether to append the `[1m]` suffix is handled in claudeCodeModelId,
      // which never tags the sentinel.
      return true;
    }
    if (isAnthropicModelId(bare)) {
      return ANTHROPIC_1M_CONTEXT_IDS.has(bare);
    }
    return true;
  }
  if (isFirerouterModelPattern(modelId)) {
    return true;
  }
  const slug = fireworksModelSlug(modelId);
  if (!slug) {
    return false;
  }
  // The [1m] tag claims a 1M window: only models with a KNOWN window qualify.
  // Unknown models resolve to the shared 1M default for sizing, but tagging
  // them would advertise context they may not have. Offline aliases resolve
  // through their base model so a cold catalog still tags them.
  const knownWindow = lookupModelSpec(modelId)?.capabilities?.contextWindow
    ?? resolveFireworksCatalog(modelId).cache.contextLength
    ?? fallbackAliasBaseWindow(slug);
  return (knownWindow ?? 0) >= CLAUDE_CODE_1M_CONTEXT_THRESHOLD;
}

const OFFLINE_ALIAS_BASE_MODELS = {
  "glm-latest": "accounts/fireworks/models/glm-5p2",
  "glm-fast-latest": "accounts/fireworks/models/glm-5p2",
  "glm-5p2-fast": "accounts/fireworks/models/glm-5p2",
  "kimi-fast-latest": "accounts/fireworks/models/kimi-k3",
};

/** Base-model window for a router alias when the live catalog is cold. */
function fallbackAliasBaseWindow(slug) {
  const base = OFFLINE_ALIAS_BASE_MODELS[slug];
  return base ? lookupModelSpec(base)?.capabilities?.contextWindow ?? null : null;
}

export function claudeCodeModelId(modelId) {
  if (!modelId || !modelQualifiesForClaudeCode1mContext(modelId)) {
    return modelId;
  }
  // The native sentinel is not a real model id — tagging it would produce
  // "claude-default[1m]". It qualifies for the 1M policy but never for a suffix.
  if (isClaudeNativeModel(modelId)) {
    return modelId;
  }
  // Like glm-latest and other 1M Fireworks models: tag with [1m] for Claude Code's
  // context window. Claude Code strips the suffix before the gateway API call, so
  // `auto[1m]` still reaches the gateway as bare `auto`.
  return `${stripClaudeCodeContextSuffix(modelId)}${CLAUDE_CODE_1M_SUFFIX}`;
}

export function applyClaudeCodeContextPolicy(env, mapping) {
  const next = { ...env };
  if (Object.values(mapping).some((modelId) => modelQualifiesForClaudeCode1mContext(modelId))) {
    delete next.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  } else {
    next.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
  }
  return next;
}

/**
 * Hydrate the serverless catalog cache before rewriting Claude Code settings so
 * 1M-context detection uses live context lengths (including router bases).
 * Best-effort: static spec fallbacks still apply when the network is down.
 * @param {{ apiKey?: string }} opts
 */
export async function ensureCatalogForClaudeCodeContext({ apiKey = "" } = {}) {
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    return;
  }
  try {
    await loadServerlessCatalog({ apiKey: trimmed });
  } catch {
    /* lookupFireworksModelLimits falls back to cache + static specs */
  }
}
