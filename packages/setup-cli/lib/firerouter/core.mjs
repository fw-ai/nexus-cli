import {
  AUTO_INSTANT_MODEL_ID,
  canonicalAutoModelId,
  isFirerouterModelPattern,
} from "../fireworks/model-id.mjs";
import { NEXUS_PROVIDERS_HEADER } from "../config/auto-providers.mjs";

export { NEXUS_PROVIDERS_HEADER };
import {
  readGlobalConfig,
  resolveStoredAnthropicApiKey,
} from "../config/global-config.mjs";
import {
  FIRECONNECT_TELEMETRY_HEADER_NAMES,
  stripFireconnectTelemetryHeaderLines,
} from "../telemetry/request-headers.mjs";

export const FIREROUTER_FIREWORKS_HEADER = "X-Fireworks-Api-Key";
export const AUTO_TAGLINE =
  "Smart routing: automatically picks the best model for the task.";
export const AUTO_INSTANT_TAGLINE =
  "Routes each user turn across the fastest Fireworks open models.";

/** @param {string} modelId  `auto` or an `auto-*` mix */
export function autoTagline(modelId) {
  return canonicalAutoModelId(modelId) === AUTO_INSTANT_MODEL_ID ? AUTO_INSTANT_TAGLINE : AUTO_TAGLINE;
}

/**
 * Description for a FireRouter id still stored in a harness config. The
 * gateway serves every FireRouter id as `auto`, so it reads the same.
 * @param {string} [_modelId]
 */
export function firerouterTagline(_modelId = "") {
  return AUTO_TAGLINE;
}

// Header the deprecated `--routing-preference` used to write. Earlier releases put it in harness
// configs, so it stays on every managed-header list and `on`/`off` strip it.
export const RETIRED_ROUTING_PREFERENCE_HEADER = "x-routing-preference";

export const CLAUDE_FIREROUTER_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
];

/** Claude model-mapping env keys that can independently use FireRouter. */
export const CLAUDE_FIREROUTER_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

/**
 * Whether any Claude model slot routes through FireRouter. A stale custom
 * header alone is deliberately not enough.
 * @param {Record<string, string>} env
 */
export function firerouterStatusFromEnv(env) {
  const slotValues = CLAUDE_FIREROUTER_MODEL_ENV_KEYS.map((key) => env[key]);
  return slotValues.some((modelId) => isFirerouterModelPattern(modelId))
    ? "firerouter"
    : "other";
}

function isFirerouterOwnedEnvEntry(key, value, env) {
  // ANTHROPIC_CUSTOM_HEADERS is handled line-by-line in stripFirerouterOwnedEnv
  // (it can mix Nexus-managed lines with user-added ones), never wholesale.
  // When any slot uses FireRouter, the complete mapping was written by
  // Nexus and is rebuilt together. Outside that state a user's own model
  // mapping is never stripped by this helper.
  if (CLAUDE_FIREROUTER_MODEL_ENV_KEYS.includes(key)) {
    return isFirerouterModelPattern(value) || firerouterStatusFromEnv(env) === "firerouter";
  }
  if (firerouterStatusFromEnv(env) !== "firerouter") {
    return false;
  }
  return CLAUDE_FIREROUTER_ENV_KEYS.includes(key);
}

/**
 * @param {Record<string, string>} env
 */
export function stripFirerouterOwnedEnv(env) {
  const nextEnv = { ...env };
  let changed = false;
  for (const key of [...CLAUDE_FIREROUTER_ENV_KEYS, ...CLAUDE_FIREROUTER_MODEL_ENV_KEYS]) {
    if (!Object.hasOwn(nextEnv, key)) {
      continue;
    }
    // ANTHROPIC_CUSTOM_HEADERS can hold user-added lines next to Nexus's
    // managed auth/routing headers (direct mode writes X-Fireworks-Api-Key here
    // too). Strip only our lines so re-running `on` — or tearing down — keeps the
    // user's own custom headers instead of dropping the whole field.
    if (key === "ANTHROPIC_CUSTOM_HEADERS") {
      if (!hasManagedCustomHeaderLine(nextEnv[key])) {
        continue;
      }
      const remaining = stripManagedCustomHeaderLines(nextEnv[key]);
      if (remaining) {
        nextEnv[key] = remaining;
      } else {
        delete nextEnv[key];
      }
      changed = true;
      continue;
    }
    if (isFirerouterOwnedEnvEntry(key, nextEnv[key], env)) {
      delete nextEnv[key];
      changed = true;
    }
  }
  return { env: nextEnv, changed };
}

/**
 * Extract the Fireworks key value from an ANTHROPIC_CUSTOM_HEADERS string
 * (matches X-Fireworks-Api-Key or the legacy header name). Returns "" when
 * absent. Used to resolve the harness-local key now that Claude direct mode
 * authenticates via the custom header rather than apiKeyHelper.
 * @param {unknown} value
 * @returns {string}
 */
/**
 * Extract the first matching header line's value from an ANTHROPIC_CUSTOM_HEADERS
 * string (case-insensitive on the header name). Returns "" when absent.
 * @param {unknown} value
 * @param {string[]} headerNames
 * @returns {string}
 */
export function customHeaderValue(value, headerNames) {
  if (typeof value !== "string") {
    return "";
  }
  const wanted = headerNames.map((name) => name.toLowerCase());
  for (const line of value.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (wanted.includes(name)) {
      return line.slice(colon + 1).trim();
    }
  }
  return "";
}

export function fireworksKeyFromCustomHeaders(value) {
  return customHeaderValue(value, [FIREROUTER_FIREWORKS_HEADER]);
}

/**
 * Extract the Anthropic BYOK key from an ANTHROPIC_CUSTOM_HEADERS string. In
 * FireRouter mode the pass-through key lives ONLY in the `x-anthropic-api-key`
 * header line (never a separate env var), so re-`on` must read it back from here
 * or it would be silently dropped.
 * @param {unknown} value
 * @returns {string}
 */
export function anthropicKeyFromCustomHeaders(value) {
  return customHeaderValue(value, [ANTHROPIC_BYOK_HEADER]);
}

/**
 * `headers` without the named entries (case-insensitive); {} when `headers`
 * is not an object.
 * @param {unknown} headers
 * @param {string[]} headerNames
 * @returns {Record<string, unknown>}
 */
export function withoutHeaders(headers, headerNames) {
  if (!headers || typeof headers !== "object") {
    return {};
  }
  const names = new Set(headerNames.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())),
  );
}

/**
 * Like {@link withoutHeaders}, but null when none of the named entries is
 * present, so callers can skip a write.
 * @param {unknown} headers
 * @param {string[]} headerNames
 * @returns {Record<string, unknown> | null}
 */
export function omitHeaders(headers, headerNames) {
  const kept = withoutHeaders(headers, headerNames);
  return headers && typeof headers === "object" && Object.keys(kept).length < Object.keys(headers).length
    ? kept
    : null;
}

/**
 * Build a `settingsEnv`-shaped object (with an ANTHROPIC_CUSTOM_HEADERS string)
 * from a harness's stored provider headers, so a repeat `on` can recover the
 * Anthropic BYOK key that lives only in those headers via
 * resolveFirerouterByokKeys. Returns `{}` when the BYOK header is absent.
 * Stored OpenAI headers ride along as OPENAI_BYOK_HEADER so resolveOpenaiKey
 * can recover them the same way.
 * @param {Record<string, string>} [headers]
 * @returns {Record<string, string>}
 */
export function byokEnvFromHeaders(headers = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  const anthropic = headers?.[ANTHROPIC_BYOK_HEADER];
  if (anthropic) {
    out.ANTHROPIC_CUSTOM_HEADERS = `${ANTHROPIC_BYOK_HEADER}: ${anthropic}`;
  }
  const openai = headers?.[OPENAI_BYOK_HEADER];
  if (openai) {
    out[OPENAI_BYOK_HEADER] = openai;
  }
  return out;
}

/**
 * Set (or replace) the Fireworks key line in an ANTHROPIC_CUSTOM_HEADERS value
 * while preserving every OTHER line the user may have added. Used by direct mode,
 * which authenticates via the X-Fireworks-Api-Key header — re-running `on` must
 * not clobber unrelated custom-header lines. Returns just the Fireworks line when
 * there is nothing else to keep.
 * @param {unknown} value  current ANTHROPIC_CUSTOM_HEADERS
 * @param {string} fireworksKey
 * @returns {string}
 */
export function setFireworksKeyInCustomHeaders(value, fireworksKey) {
  const key = fireworksKey?.trim();
  const others = stripFireworksKeyFromCustomHeaders(value);
  const fireworksLine = key ? `${FIREROUTER_FIREWORKS_HEADER}: ${key}` : "";
  return [fireworksLine, others].filter(Boolean).join("\n");
}

/**
 * Remove any Fireworks-key line(s) from an ANTHROPIC_CUSTOM_HEADERS value,
 * preserving all other lines. Returns "" when nothing remains, so callers can
 * drop the key entirely on teardown.
 * @param {unknown} value
 * @returns {string}
 */
export function stripFireworksKeyFromCustomHeaders(value) {
  return stripCustomHeaderLines(value, [FIREROUTER_FIREWORKS_HEADER]);
}

/**
 * Remove the named header line(s) from an ANTHROPIC_CUSTOM_HEADERS value,
 * preserving all other lines. Returns "" when nothing remains.
 * @param {unknown} value
 * @param {string[]} headerNames
 * @returns {string}
 */
export function stripCustomHeaderLines(value, headerNames) {
  if (typeof value !== "string") {
    return "";
  }
  const names = headerNames.map((name) => name.toLowerCase());
  return value
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      const colon = line.indexOf(":");
      const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
      return !names.includes(name);
    })
    .join("\n");
}

// BYOK header FireRouter reads to pass a request through to real Anthropic
// models using the user's own Anthropic key. Sent as a custom header (not
// ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN) so it can't collide with the
// X-Fireworks-Api-Key that authenticates the gateway.
export const ANTHROPIC_BYOK_HEADER = "x-anthropic-api-key";
// BYOK header FireRouter reads to pass a request through to real OpenAI models
// using the user's own OpenAI key. Same custom-header mechanism, so the
// Fireworks gateway key stays the sole gateway credential.
export const OPENAI_BYOK_HEADER = "x-openai-api-key";
/** Request-body field FireRouter reads on the VS Code Chat wire (firerouter model). */
export const ANTHROPIC_BYOK_BODY_FIELD = "anthropic_api_key";

/** Every ANTHROPIC_CUSTOM_HEADERS line Nexus writes or has written. */
const MANAGED_CUSTOM_HEADER_NAMES = [
  FIREROUTER_FIREWORKS_HEADER,
  ANTHROPIC_BYOK_HEADER,
  OPENAI_BYOK_HEADER,
  NEXUS_PROVIDERS_HEADER,
  RETIRED_ROUTING_PREFERENCE_HEADER,
  ...FIRECONNECT_TELEMETRY_HEADER_NAMES,
].map((name) => name.toLowerCase());

/** @param {unknown} value @returns {boolean} */
export function hasManagedCustomHeaderLine(value) {
  if (typeof value !== "string") {
    return false;
  }
  return stripFireconnectTelemetryHeaderLines(value) !== value
    || value.split("\n").some((line) => {
    const colon = line.indexOf(":");
    const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
    return MANAGED_CUSTOM_HEADER_NAMES.includes(name);
  });
}

/**
 * Remove every Nexus-managed header line (Fireworks key — current or
 * legacy — plus BYOK and retired routing-preference headers) from an
 * ANTHROPIC_CUSTOM_HEADERS value, preserving all user-added lines. Returns ""
 * when nothing remains, so callers can drop the key entirely on teardown.
 * @param {unknown} value
 * @returns {string}
 */
export function stripManagedCustomHeaderLines(value) {
  if (typeof value !== "string") {
    return "";
  }
  const withoutRouting = value
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      const colon = line.indexOf(":");
      const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
      return !MANAGED_CUSTOM_HEADER_NAMES.includes(name);
    })
    .join("\n");
  return stripFireconnectTelemetryHeaderLines(withoutRouting);
}

/**
 * Claude Code reads proxy auth from ANTHROPIC_CUSTOM_HEADERS, which accepts
 * multiple `Name: Value` lines separated by newlines. The Fireworks key
 * authenticates the gateway via X-Fireworks-Api-Key (which wins over any
 * x-api-key / Authorization a user's ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 * would otherwise inject); an optional Anthropic key rides along as a BYOK
 * header so FireRouter can pass hard turns through to real Anthropic models,
 * and a configured OpenAI key rides along the same way for OpenAI members.
 * @param {{ fireworksKey: string, anthropicKey?: string, openaiKey?: string, nexusProviders?: string, telemetryHeaders?: Record<string,string> }} keys
 */
export function buildClaudeCustomHeaders({
  fireworksKey,
  anthropicKey = "",
  openaiKey = "",
  nexusProviders = "",
  telemetryHeaders = {},
}) {
  const lines = [`${FIREROUTER_FIREWORKS_HEADER}: ${fireworksKey}`];
  if (anthropicKey?.trim()) {
    lines.push(`${ANTHROPIC_BYOK_HEADER}: ${anthropicKey.trim()}`);
  }
  if (openaiKey?.trim()) {
    lines.push(`${OPENAI_BYOK_HEADER}: ${openaiKey.trim()}`);
  }
  if (nexusProviders?.trim()) {
    lines.push(`${NEXUS_PROVIDERS_HEADER}: ${nexusProviders.trim()}`);
  }
  for (const [name, value] of Object.entries(telemetryHeaders)) {
    lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

/**
 * BYOK headers for OpenAI-wire harnesses' provider config (OpenCode/Codex/Pi/
 * VS Code): the user's Anthropic and/or OpenAI keys, so FireRouter can pass
 * hard turns through to real Anthropic/OpenAI models. Empty entries are
 * omitted, so a configured key is forwarded while a missing one stays absent
 * instead of failing the `on`.
 * @param {{ anthropicKey?: string, openaiKey?: string }} keys
 * @returns {Record<string, string>}
 */
export function firerouterByokHeaders({ anthropicKey = "", openaiKey = "" } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (anthropicKey?.trim()) {
    headers[ANTHROPIC_BYOK_HEADER] = anthropicKey.trim();
  }
  if (openaiKey?.trim()) {
    headers[OPENAI_BYOK_HEADER] = openaiKey.trim();
  }
  return headers;
}

/**
 * Swap the Fireworks key inside an ANTHROPIC_CUSTOM_HEADERS value while
 * preserving every other line (BYOK keys, user-added headers).
 * Returns the input unchanged (same reference) when it isn't FireRouter-shaped
 * or there is no key to swap in; callers use identity to mean "nothing to
 * write".
 * @param {unknown} value  current ANTHROPIC_CUSTOM_HEADERS
 * @param {string} fireworksKey
 */
export function replaceFireworksKeyInCustomHeaders(value, fireworksKey) {
  if (typeof value !== "string" || !fireworksKey?.trim()) {
    return value;
  }
  const fireworksHeaderNames = [FIREROUTER_FIREWORKS_HEADER.toLowerCase()];
  let found = false;
  const lines = value.split("\n").map((line) => {
    const colon = line.indexOf(":");
    const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
    if (!fireworksHeaderNames.includes(name)) {
      return line;
    }
    found = true;
    return `${FIREROUTER_FIREWORKS_HEADER}: ${fireworksKey.trim()}`;
  });
  return found ? lines.join("\n") : value;
}

/** Anthropic API keys start with `sk-ant-`. */
export function isAnthropicShapedKey(key) {
  return typeof key === "string" && key.trim().startsWith("sk-ant-");
}

/**
 * OpenAI API keys start with `sk-` (including `sk-proj-...`) but never with
 * Anthropic's `sk-ant-` prefix, so the two families stay disjoint: a key that
 * satisfies one shape can never satisfy the other.
 */
export function isOpenAIShapedKey(key) {
  const trimmed = typeof key === "string" ? key.trim() : "";
  return trimmed.startsWith("sk-") && !trimmed.startsWith("sk-ant-");
}

/**
 * @param {{
 *   apiKey?: string,
 *   settingsEnv?: Record<string, string>,
 *   home?: string,
 * }} input
 */
export async function resolveAnthropicKey({
  apiKey = "",
  settingsEnv = {},
  home = "",
} = {}) {
  const fromFlag = apiKey?.trim() ?? "";
  if (fromFlag && isAnthropicShapedKey(fromFlag)) {
    return fromFlag;
  }
  if (home) {
    const config = await readGlobalConfig(home);
    const fromGlobal = resolveStoredAnthropicApiKey(config.anthropicApiKey);
    if (fromGlobal && isAnthropicShapedKey(fromGlobal)) {
      return fromGlobal;
    }
  }
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (fromEnv && isAnthropicShapedKey(fromEnv)) {
    return fromEnv;
  }
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    const value = settingsEnv[key]?.trim() ?? "";
    if (value && isAnthropicShapedKey(value)) {
      return value;
    }
  }
  // FireRouter mode keeps the pass-through key only in the custom-header line,
  // so re-`on` must read it back from there to avoid dropping it.
  const fromHeader = anthropicKeyFromCustomHeaders(settingsEnv.ANTHROPIC_CUSTOM_HEADERS);
  if (fromHeader && isAnthropicShapedKey(fromHeader)) {
    return fromHeader;
  }
  return "";
}

/**
 * Extract the OpenAI BYOK key from an ANTHROPIC_CUSTOM_HEADERS string (Claude
 * Code wire) or a provider-headers map entry. Returns "" when absent.
 * @param {unknown} value
 * @returns {string}
 */
export function openaiKeyFromCustomHeaders(value) {
  return customHeaderValue(value, [OPENAI_BYOK_HEADER]);
}
