import { fetchModelsDevApi } from "../pricing/models-dev.mjs";

/**
 * Lazy cache of Fireworks model ids listed on models.dev for the fireworks-ai
 * provider. OpenCode resolves standard catalog entries through models.dev; when
 * a model is absent there, Nexus must write provider.models limits itself.
 */

/** @type {Set<string> | null} */
let fireworksModelIds = null;

/**
 * @param {Iterable<string> | null} ids
 */
export function setModelsDevFireworksRegistry(ids) {
  if (!ids) {
    fireworksModelIds = null;
    return;
  }
  const next = new Set(ids);
  fireworksModelIds = next.size ? next : null;
}

export function clearModelsDevFireworksRegistry() {
  fireworksModelIds = null;
}

/**
 * @param {string} modelId full accounts/fireworks/... id
 * @returns {"present" | "absent" | "unknown"}
 */
export function modelsDevRegistryStatus(modelId) {
  if (!modelId || !fireworksModelIds?.size) {
    return "unknown";
  }
  return fireworksModelIds.has(modelId) ? "present" : "absent";
}

/**
 * @param {string} raw models.dev api.json body
 * @returns {Set<string>}
 */
export function parseModelsDevFireworksModelIds(raw) {
  const ids = new Set();
  const marker = '"fireworks-ai"';
  const idx = raw.indexOf(marker);
  if (idx < 0) {
    return ids;
  }
  const slice = raw.slice(idx, idx + 800_000);
  const re = /"(accounts\/fireworks\/(?:models|routers)\/[^"]+)"/g;
  for (const match of slice.matchAll(re)) {
    ids.add(match[1]);
  }
  return ids;
}

/**
 * Replace the in-memory registry when parsing produced at least one id.
 * Empty parses leave the prior snapshot (or unknown) untouched.
 * @param {Set<string>} ids
 * @returns {boolean}
 */
export function replaceModelsDevFireworksRegistry(ids) {
  if (!ids?.size) {
    return false;
  }
  fireworksModelIds = ids;
  return true;
}

/**
 * Refresh the in-memory models.dev Fireworks catalog. Best-effort; failures leave
 * the prior snapshot (or unknown) in place.
 * @returns {Promise<boolean>}
 */
export async function refreshModelsDevFireworksRegistry() {
  if (process.env.NEXUS_TEST === "1") {
    return Boolean(fireworksModelIds?.size);
  }
  return replaceModelsDevFireworksRegistry(
    parseModelsDevFireworksModelIds(await fetchModelsDevApi()),
  );
}
