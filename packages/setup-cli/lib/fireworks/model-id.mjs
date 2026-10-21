import {
  AUTO_INSTANT_MODEL_ID,
  AUTO_MODEL_ID,
  KNOWN_AUTO_MODEL_IDS,
  canonicalAutoModelId,
  isAutoModelId,
  isFirerouterModelPattern,
  isRouterShortId,
} from "./model-specs.mjs";

export {
  AUTO_INSTANT_MODEL_ID,
  AUTO_MODEL_ID,
  KNOWN_AUTO_MODEL_IDS,
  canonicalAutoModelId,
  isAutoModelId,
  isFirerouterModelPattern,
};

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference";
export const FIREROUTER_MODEL_ID = "firerouter";
// Reserved slot value meaning "don't pin this Claude Code slot — let it fall back
// to Claude's own (Anthropic) default model." The Fireworks gateway serves
// Anthropic models even though they aren't in the serverless catalog, so the
// writer translates this sentinel into "omit the pin" rather than a model id.
export const CLAUDE_NATIVE_MODEL_ID = "claude-default";
/** User-facing label for an unpinned Claude Code slot (native Anthropic default). */
export const CLAUDE_NATIVE_SLOT_LABEL = "Claude default";
/** CLI slot value meaning "use Claude's native Anthropic default for this slot". */
export const CLAUDE_NATIVE_SLOT_ALIAS = "native";
export const FIREROUTER_ROUTER_ID =
  "accounts/fireworks/routers/firerouter";
export const GLM_LATEST_ROUTER_ID =
  "accounts/fireworks/routers/glm-latest";
export const GLM_FAST_LATEST_ROUTER_ID =
  "accounts/fireworks/routers/glm-fast-latest";
export const KIMI_FAST_LATEST_ROUTER_ID =
  "accounts/fireworks/routers/kimi-fast-latest";
export const DEEPSEEK_FLASH_LATEST_ROUTER_ID =
  "accounts/fireworks/routers/deepseek-flash-latest";
export const DEFAULT_MAIN_MODEL = AUTO_MODEL_ID;

export function resolveDefaultMainModel() {
  return DEFAULT_MAIN_MODEL;
}

const PUBLIC_FIREWORKS_MODEL_REF_RE =
  /^accounts\/fireworks\/(?:models|routers)\/([^/]+?)(\[1m\])?$/i;

function stripContextSuffix(model) {
  return typeof model === "string"
    ? model.replace(/\[1m\]$/i, "")
    : model;
}

const FIREWORKS_ACCOUNT_PREFIX = "accounts/fireworks/";

function withCanonicalFireworksAccountPrefix(model) {
  if (!model.toLowerCase().startsWith(FIREWORKS_ACCOUNT_PREFIX)) {
    return model;
  }
  return `${FIREWORKS_ACCOUNT_PREFIX}${model.slice(FIREWORKS_ACCOUNT_PREFIX.length)}`;
}

/**
 * Convert a public Fireworks model/router resource name to the short reference
 * accepted by the inference gateway. Existing short and non-public refs are
 * returned unchanged, and a Claude Code [1m] suffix is preserved.
 */
export function shortFireworksModelRef(model) {
  if (typeof model !== "string") {
    return model;
  }
  const match = model.match(PUBLIC_FIREWORKS_MODEL_REF_RE);
  return match ? `${match[1]}${match[2] ?? ""}` : model;
}

/** Return the suffix-free final slug from a Fireworks model reference. */
export function fireworksModelSlug(model) {
  const shortRef = shortFireworksModelRef(model);
  if (typeof shortRef !== "string") {
    return "";
  }
  const bare = stripContextSuffix(shortRef);
  return bare.split("/").at(-1) ?? bare;
}

export function isFirerouterModel(model) {
  if (typeof model !== "string") {
    return false;
  }
  const bare = stripContextSuffix(model.trim()).split("/").at(-1) ?? "";
  return bare.toLowerCase() === FIREROUTER_MODEL_ID;
}

/**
 * Bare `firerouter` or `firerouter/<member>/…` with no empty segment.
 * Stricter than {@link isFirerouterModelPattern}: admission rejects lookalikes
 * (`foo/firerouter-clone`, `firerouter/`); routing and display stay liberal.
 * @param {string} model
 * @returns {boolean}
 */
export function isFirerouterRouteRef(model) {
  if (typeof model !== "string") {
    return false;
  }
  const ref = stripContextSuffix(model.trim()).toLowerCase();
  if (ref === FIREROUTER_MODEL_ID) {
    return true;
  }
  if (!ref.startsWith(`${FIREROUTER_MODEL_ID}/`)) {
    return false;
  }
  // Every member must be a real segment. `firerouter/`, `firerouter//kimi`,
  // and `firerouter/astra/` are not gateway routes.
  const members = ref.slice(FIREROUTER_MODEL_ID.length + 1).split("/");
  return members.every((segment) => (
    segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !/\s/.test(segment)
  ));
}

/**
 * Whether a model id is the retired `auto-instant` mix. Recognition stays
 * (labels, pricing, migration of stored selections); only support is gone.
 * @param {string} model
 * @returns {boolean}
 */
export function isAutoInstantModelId(model) {
  return canonicalAutoModelId(model) === AUTO_INSTANT_MODEL_ID;
}

/**
 * Whether a model id names a retired selection Nexus no longer supports:
 * any FireRouter route, or the `auto-instant` mix.
 * @param {string} model
 * @returns {boolean}
 */
export function isRetiredModelId(model) {
  return isFirerouterModelPattern(model) || isAutoInstantModelId(model);
}

/**
 * The model a retired selection moves to when Nexus drops it on upgrade or
 * a plain re-`on`: the `auto` mix. Supported ids pass through unchanged.
 * New selections never reach this helper (they are rejected at admission);
 * it only rewrites selections Nexus itself is carrying over from an
 * earlier `on`.
 * @param {string} model
 * @returns {string}
 */
export function dropRetiredModelId(model) {
  return isRetiredModelId(model) ? AUTO_MODEL_ID : model;
}

/**
 * Whether a FireRouter selection uses an Anthropic credential: bare
 * `firerouter` (Claude Opus when an Anthropic key is present) or any
 * Claude/Opus model in the slash path. Pure-Fireworks selections
 * (firerouter/kimi-k3) use no Anthropic key.
 * @param {string} model
 * @returns {boolean}
 */
export function firerouterRequiresAnthropicKey(model) {
  if (!isFirerouterModelPattern(model)) {
    return false;
  }
  if (isFirerouterModel(model)) {
    return true;
  }
  return firerouterNamesAnthropicModel(model);
}

/**
 * Whether a FireRouter slash path names a Claude/Opus model. Bare `firerouter`
 * names none: it serves a GPT model with only an OpenAI credential and open models
 * with no closed-model credential, so harnesses that cannot forward an
 * Anthropic key can still use it.
 * @param {string} model
 * @returns {boolean}
 */
export function firerouterNamesAnthropicModel(model) {
  if (!isFirerouterModelPattern(model) || isFirerouterModel(model)) {
    return false;
  }
  const stripped = stripContextSuffix(String(model ?? "").trim());
  return stripped.split("/").some((part) => {
    const seg = part.trim().toLowerCase();
    return seg === "claude"
      || seg.startsWith("claude-")
      || CLAUDE_MODEL_ALIASES.has(seg);
  });
}

/**
 * Whether a FireRouter selection routes to an OpenAI model in the slash path
 * (e.g. firerouter/gpt-5p6, firerouter/openai/<id>), so a configured OpenAI
 * key should ride along as `x-openai-api-key` (matches `openai`, `gpt`,
 * `gpt-*`, `openai-*`, and the o-series reasoning ids). Bare `firerouter`
 * returns false
 * here: its primary is Claude, and an OpenAI key is attached opportunistically
 * (when configured) rather than required.
 * @param {string} model
 * @returns {boolean}
 */
export function firerouterRequiresOpenaiKey(model) {
  if (!isFirerouterModelPattern(model)) {
    return false;
  }
  if (isFirerouterModel(model)) {
    return false;
  }
  const stripped = stripContextSuffix(String(model ?? "").trim());
  return stripped.split("/").some((part) => {
    const seg = part.trim().toLowerCase();
    return seg === "openai"
      || seg === "gpt"
      || seg.startsWith("gpt-")
      || seg.startsWith("openai-")
      // OpenAI reasoning models: o1, o3, o4-mini, ...
      || /^o\d/.test(seg);
  });
}

/**
 * Whether a model reference is a real Anthropic model id (e.g. claude-sonnet-4-5).
 * Anthropic models are served on the Fireworks gateway even though they don't
 * appear in the public serverless catalog, so they're exempt from catalog
 * validation and treated as vision-capable. Bare "claude" is NOT matched: it
 * names no concrete model, so it stays subject to catalog validation and is
 * reported as unavailable rather than being guessed at.
 * @param {string} model
 * @returns {boolean}
 */
export function isAnthropicModelId(model) {
  if (typeof model !== "string") {
    return false;
  }
  const bare = stripContextSuffix(model.trim());
  if (isClaudeNativeModel(bare)) {
    return false;
  }
  return /^claude-[a-z0-9.-]+(\[1m\])?$/i.test(bare);
}

/** Whether a user-supplied slot value is the native-default alias (`native`). */
export function isClaudeNativeSlotAlias(model) {
  if (typeof model !== "string") {
    return false;
  }
  return model.trim().toLowerCase() === CLAUDE_NATIVE_SLOT_ALIAS;
}

/**
 * Claude Code `/model` picker aliases that resolve at request time through the
 * matching `ANTHROPIC_DEFAULT_*_MODEL` env slot (opus/sonnet/haiku/fable). They
 * name no concrete model themselves, so Nexus never writes one — a bare
 * alias in `settings.model` is the user's picker choice, not a Nexus pin.
 */
const CLAUDE_MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

/** FireRouter's GPT family aliases (`firerouter/sol`, …). */
export const OPENAI_MODEL_FAMILIES = Object.freeze(["astra", "sol", "luna"]);

/**
 * Members of a `firerouter/<member>/…` route, lowercased; `[]` for bare
 * `firerouter` or a non-FireRouter id.
 * @param {string} model
 * @returns {string[]}
 */
export function firerouterRouteMembers(model) {
  if (!isFirerouterModelPattern(model) || isFirerouterModel(model)) {
    return [];
  }
  const ref = stripContextSuffix(String(model).trim())
    .replace(/^accounts\/fireworks\/(?:models|routers)\//i, "")
    .toLowerCase();
  return ref.split("/").slice(1).filter(Boolean);
}

/**
 * Whether a route member names a closed (Anthropic or OpenAI) model or family.
 * @param {string} member
 * @returns {boolean}
 */
export function isClosedFirerouterMember(member) {
  const seg = String(member ?? "").trim().toLowerCase();
  return seg === "claude"
    || seg.startsWith("claude-")
    || CLAUDE_MODEL_ALIASES.has(seg)
    || OPENAI_MODEL_FAMILIES.includes(seg)
    || seg === "openai"
    || seg === "gpt"
    || seg.startsWith("gpt-")
    || seg.startsWith("openai-")
    || /^o\d/.test(seg);
}

/** Whether a model reference is a bare Claude Code `/model` picker alias. */
export function isClaudeModelAlias(model) {
  if (typeof model !== "string") {
    return false;
  }
  return CLAUDE_MODEL_ALIASES.has(stripContextSuffix(model.trim()).toLowerCase());
}

/**
 * Whether a model reference is the reserved native-Claude slot value.
 *
 * Case-insensitive: {@link isAnthropicModelId} matches `claude-*` without regard
 * to case, so a case-variant sentinel that isn't recognized here is classified as
 * a real Anthropic model and written into the harness config verbatim.
 */
export function isClaudeNativeModel(model) {
  if (typeof model !== "string") {
    return false;
  }
  return stripContextSuffix(model.trim()).toLowerCase() === CLAUDE_NATIVE_MODEL_ID;
}

/** Native sentinel or concrete Anthropic id — served on the gateway, not the catalog. */
export function isGatewayAnthropicSlot(model) {
  return isClaudeNativeModel(model) || isAnthropicModelId(model);
}

/** Human label for a slot model id; native slots read as {@link CLAUDE_NATIVE_SLOT_LABEL}. */
export function formatClaudeSlotModelLabel(modelId) {
  return isClaudeNativeModel(modelId) ? CLAUDE_NATIVE_SLOT_LABEL : modelId;
}

/**
 * Expand a short gateway slug to a full accounts/fireworks resource id for
 * catalog/spec lookups. Stored harness config keeps short slugs as-is.
 * @param {string} model
 * @returns {string}
 */
export function fullFireworksResourceId(model) {
  const bare = stripContextSuffix(String(model ?? "").trim());
  if (!bare) {
    return bare;
  }
  if (bare.toLowerCase().startsWith(FIREWORKS_ACCOUNT_PREFIX)) {
    return withCanonicalFireworksAccountPrefix(bare);
  }
  if (bare.includes("/")) {
    return bare;
  }
  if (isFirerouterModel(bare)) {
    return FIREROUTER_ROUTER_ID;
  }
  // `auto` / `auto-*` have no accounts/fireworks resource path — the gateway
  // serves them under the bare slug only, so they pass through unexpanded.
  if (isAutoModelId(bare)) {
    return canonicalAutoModelId(bare);
  }
  // Classify routers by the same suffix/alias heuristic spec lookups use
  // (`isRouterShortId`), not a hand-maintained list. A stale list would expand a
  // real router slug (e.g. kimi-k3-fast) to a non-existent models/ path, which
  // then fails to match its catalog row and yields duplicate Pi model entries.
  const kind = isRouterShortId(bare) ? "routers" : "models";
  return `accounts/fireworks/${kind}/${bare}`;
}

/**
 * Normalize a user-supplied model id to the short slug Fireworks accepts.
 * Full accounts/fireworks/... refs are shortened; bare slugs pass through.
 * @param {string} model
 * @returns {string}
 */
export function normalizeModelId(model) {
  if (typeof model !== "string") {
    return model;
  }
  const bare = stripContextSuffix(model.trim());
  if (!bare) {
    return bare;
  }
  // Collapse only bare firerouter and the two provider spellings. Any other
  // path whose last segment is firerouter (`foo/firerouter`) is a different id.
  if (
    isFirerouterModel(bare)
    && (!bare.includes("/") || /^(?:fireworks-ai|fireworks)\/firerouter$/i.test(bare))
  ) {
    return FIREROUTER_MODEL_ID;
  }
  if (isAutoModelId(bare)) {
    return canonicalAutoModelId(bare);
  }
  if (isClaudeNativeSlotAlias(bare) || isClaudeNativeModel(bare)) {
    return CLAUDE_NATIVE_MODEL_ID;
  }
  if (isFirerouterRouteRef(bare)) {
    return bare.toLowerCase();
  }
  if (bare.toLowerCase().startsWith(FIREWORKS_ACCOUNT_PREFIX)) {
    const shortened = shortFireworksModelRef(bare);
    return shortened === bare
      ? withCanonicalFireworksAccountPrefix(bare)
      : shortened;
  }
  if (bare.includes("/")) {
    return bare;
  }
  return bare;
}

/**
 * Reject a user-supplied retired selection: a FireRouter route or the
 * `auto-instant` mix. Both are retired: existing installs are migrated off
 * them on upgrade/re-`on` ({@link dropRetiredModelId}), and new selections
 * must name `auto` or a concrete Fireworks model. Reading/migrating stored
 * ids stays allowed — this gate is only for ids a user is asking to store
 * now.
 * @param {string} model
 * @param {string} [flag]
 */
export function assertNotFirerouterModelId(model, flag = "--model") {
  if (isFirerouterModelPattern(model)) {
    throw new Error(
      `${flag} ${String(model).trim()} is a FireRouter route, which is no longer supported. `
      + `Use ${flag} auto instead.`,
    );
  }
  if (isAutoInstantModelId(model)) {
    throw new Error(
      `${flag} ${String(model).trim()} is no longer supported. `
      + `Use ${flag} auto instead.`,
    );
  }
}

/**
 * Id to admit and store. Empty means the harness default.
 * Collapses spellings {@link normalizeModelId} already understands, then
 * applies the shape gate so every harness rejects the same slash forms.
 * @param {string | undefined | null} model
 * @param {string} [flag]
 * @returns {string}
 */
export function canonicalRequestedModelId(model, flag = "--model") {
  if (typeof model !== "string" || !model.trim()) {
    return "";
  }
  const normalized = normalizeModelId(model);
  if (isClaudeNativeModel(normalized)) {
    throw new Error(`${flag} ${model.trim()} is not a Fireworks model id.`);
  }
  assertNotFirerouterModelId(normalized, flag);
  if (normalized) {
    validateModelId(normalized, flag);
  }
  return normalized;
}

/** Shape only: bare slug or an `accounts/…` resource. FireRouter routes are rejected above this gate. */
export function validateModelId(model, flag) {
  assertNotFirerouterModelId(model, flag);
  const accepted = !model.includes("/") || /^accounts\//i.test(model);
  if (accepted) {
    return;
  }
  throw new Error(
    `${flag} must be a Fireworks model ID like kimi-k3 or a router ID like glm-latest`,
  );
}

export function defaultMainModel() {
  return resolveDefaultMainModel();
}
