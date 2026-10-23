/**
 * Provider scope for the `auto` router, customized by `nexus auto`.
 *
 * Stored once in the global config and harness-agnostic: every harness
 * `on` writes it into that harness's own settings, in whatever form the
 * harness carries per-request values. `null` (unset) is the default:
 * nothing extra is written, and `auto` chooses based on the user's setup.
 */

import { HARNESS } from "../harness/id.mjs";

export const NEXUS_PROVIDERS_HEADER = "x-nexus-providers";

/** Request headers that carry the user's own keys to Nexus Auto. */
export const AUTO_PROVIDER_KEY_HEADERS = Object.freeze({
  anthropic: "x-anthropic-api-key",
  openai: "x-openai-api-key",
});

/**
 * Harnesses that cannot carry this setting yet: their provider config
 * has no per-request settings channel for Nexus to write into. (Claude
 * Desktop is *not* here: its requests pass through the Nexus shim,
 * which applies the current scope live.) The stored scope is global,
 * so these pick it up as soon as they gain a channel. Displayed to
 * users wherever the steps are shown, so nobody is told to re-run a
 * harness this can't affect.
 */
export const AUTO_UNSUPPORTED_HARNESSES = Object.freeze([
  { id: HARNESS.CURSOR, label: "Cursor IDE" },
]);

const AUTO_UNSUPPORTED_IDS = new Set(AUTO_UNSUPPORTED_HARNESSES.map(({ id }) => id));

/** @param {string} harnessId */
export function autoHarnessSupported(harnessId) {
  return !AUTO_UNSUPPORTED_IDS.has(harnessId);
}

/**
 * Providers `nexus auto` can scope to today, in canonical order for
 * storage, display, and the header value. Only Fireworks is supported
 * for now; extend this list when `auto` learns another provider.
 */
export const AUTO_PROVIDER_IDS = Object.freeze([
  "fireworks",
]);

/**
 * Parse a `--providers` list. Strict: unknown ids and empty segments are
 * errors rather than being dropped, so a typo can't silently widen scope.
 * @param {string} raw
 * @param {string} [flag]
 * @returns {string[]} providers in canonical order
 */
export function parseAutoProviders(raw, flag = "--providers") {
  const parts = String(raw ?? "").split(",").map((part) => part.trim().toLowerCase());
  if (parts.some((part) => !part)) {
    throw new Error(
      `${flag} must be a comma-separated list from: ${AUTO_PROVIDER_IDS.join(", ")}.`,
    );
  }
  const unknown = parts.filter((part) => !AUTO_PROVIDER_IDS.includes(part));
  if (unknown.length) {
    throw new Error(
      `${flag} got unknown provider${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. `
        + `Use one or more of: ${AUTO_PROVIDER_IDS.join(", ")}.`,
    );
  }
  return AUTO_PROVIDER_IDS.filter((id) => parts.includes(id));
}

/**
 * Normalize a stored providers value. Unrecognized entries are dropped.
 * A stored list with nothing recognized reads as an empty scope (`[]`),
 * not unset: no `x-nexus-providers` header is sent and no saved provider
 * key is sent, so an unknown value (future version, hand-edit) can never
 * widen scope back to the default. Only a missing/non-list value is
 * unset (`null`, the default).
 * @param {unknown} raw
 * @returns {string[] | null}
 */
export function normalizeAutoProviders(raw) {
  if (!Array.isArray(raw)) {
    return null;
  }
  const valid = raw
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  return AUTO_PROVIDER_IDS.filter((id) => valid.includes(id));
}

/**
 * Normalize the stored `auto` settings object.
 * @param {unknown} raw
 * @returns {{ providers: string[] | null }}
 */
export function normalizeAutoSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { providers: null };
  }
  return { providers: normalizeAutoProviders(raw.providers) };
}

/** @param {string[] | null} providers */
export function formatAutoProviders(providers) {
  return providers?.length ? providers.join(",") : "";
}

/**
 * The request headers carrying the scope, or `{}` when unset (default).
 * @param {string[] | null} providers
 * @returns {Record<string, string>}
 */
export function nexusProvidersHeaders(providers) {
  const value = formatAutoProviders(providers);
  return value ? { [NEXUS_PROVIDERS_HEADER]: value } : {};
}

/**
 * Anthropic and OpenAI keys saved with `nexus auto` for Nexus Auto to use.
 * Literal keys only: an environment reference (`{env:...}`) or a value of the
 * wrong shape reads as unset. Nexus never sends a key from the environment;
 * a harness may still read one on its own (Claude Code reads
 * ANTHROPIC_API_KEY, Codex signs in with an OpenAI key).
 * @param {{ anthropicApiKey?: string, openaiApiKey?: string } | null | undefined} config
 * @returns {{ anthropicKey: string, openaiKey: string }}
 */
export function savedAutoProviderKeys(config) {
  const literal = (value) => (typeof value === "string" && !value.trim().startsWith("{env:") ? value.trim() : "");
  const anthropic = literal(config?.anthropicApiKey);
  const openai = literal(config?.openaiApiKey);
  return {
    anthropicKey: anthropic.startsWith("sk-ant-") ? anthropic : "",
    openaiKey: openai.startsWith("sk-") && !openai.startsWith("sk-ant-") ? openai : "",
  };
}

/**
 * Whether the `nexus auto` scope lets `auto` use this provider. Unset scope
 * allows every provider; a set scope allows only the providers it names, so
 * `--providers fireworks` leaves out Anthropic and OpenAI.
 * @param {{ auto?: unknown } | null | undefined} config
 * @param {"anthropic" | "openai"} provider
 */
export function autoScopeAllows(config, provider) {
  const { providers } = normalizeAutoSettings(config?.auto);
  return !providers || providers.includes(provider);
}

/**
 * The saved keys Nexus sends: each one only while the `nexus auto` scope
 * allows its provider. A scoped-out key stays saved and is sent again once
 * the scope allows it (`nexus auto --reset`).
 * @param {{ auto?: unknown, anthropicApiKey?: string, openaiApiKey?: string } | null | undefined} config
 * @returns {{ anthropicKey: string, openaiKey: string }}
 */
export function autoProviderKeysInScope(config) {
  const saved = savedAutoProviderKeys(config);
  return {
    anthropicKey: autoScopeAllows(config, "anthropic") ? saved.anthropicKey : "",
    openaiKey: autoScopeAllows(config, "openai") ? saved.openaiKey : "",
  };
}
