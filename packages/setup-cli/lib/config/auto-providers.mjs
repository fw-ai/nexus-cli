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
 * Normalize a stored providers value. Anything unrecognized is dropped;
 * an empty result reads as unset (`null`).
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
  const providers = AUTO_PROVIDER_IDS.filter((id) => valid.includes(id));
  return providers.length ? providers : null;
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
