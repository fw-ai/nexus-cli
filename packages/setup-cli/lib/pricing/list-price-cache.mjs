/**
 * Disk-cached Anthropic/OpenAI list prices sourced from models.dev. Each row
 * also keeps the model's context window, image support, and family, which the
 * Codex catalog reads for the OpenAI models its sign-in can use.
 *
 * `lib/demo/list-pricing.mjs` keeps a hardcoded rate table as the offline
 * fallback, but new models (e.g. Claude Opus 5.5, launched after that table was
 * last verified) would otherwise price at an estimated reference rate. This
 * module refreshes those rates from https://models.dev/api.json — which
 * already carries per-model cost, fast-mode, and long-context tiers — and
 * persists them on the shared catalog TTL so the Claude cost engine, status
 * line, and demo pricing all resolve offline after a single networked run.
 *
 * Reads are synchronous (in-memory snapshot, lazy-loaded from disk) because
 * every consumer (statusline, usage meter) runs on hot paths that must never
 * block on the network. Refreshes are explicit and best-effort: `model list`,
 * harness `on` paths, and the OpenCode models.dev refresh all call
 * {@link refreshListPriceCache} without awaiting fresh data.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogTtlMs, scopedCacheFilePath } from "../fireworks/serverless-catalog-cache.mjs";
import { fetchModelsDevApi } from "./models-dev.mjs";

/** Where cached rows claim their rates came from. */
export const MODELS_DEV_PRICING_SOURCE = "https://models.dev";

// Freshness shares the serverless catalog TTL (1h, overridable for tests via
// NEXUS_CATALOG_TTL_MS): one knob for every catalog read, so list prices
// go stale — and refresh — on exactly the same cadence.

/**
 * Provider-level derivation rules (documented multipliers, not per-model
 * statics) applied when a models.dev cost block omits a field:
 * - cache reads bill at 0.1x input on both providers;
 * - Anthropic 5m cache writes at 1.25x input, 1h writes at 2x input;
 * - OpenAI has a single automatic cache billed at 1.25x input, so both write
 *   fields carry one rate (mirrors the hardcoded table's convention).
 */
function deriveBaseRow(cost, { provider }) {
  const input = Number(cost?.input ?? 0) || 0;
  const output = Number(cost?.output ?? 0) || 0;
  if (input <= 0 && output <= 0) {
    return null;
  }
  const cacheRead = Number(cost?.cache_read ?? input * 0.1) || 0;
  const cacheWrite = Number(cost?.cache_write ?? input * 1.25) || 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite5m: cacheWrite,
    cacheWrite1h: provider === "anthropic" ? input * 2 : cacheWrite,
  };
}

function deriveFastRow(cost, { provider }) {
  return deriveBaseRow(cost, { provider });
}

/** OpenAI long-context tier: explicit context-tier rows win, legacy flat field otherwise. */
function deriveLongTier(cost) {
  const tiers = Array.isArray(cost?.tiers) ? cost.tiers : [];
  const contextual = tiers.find((tier) => tier?.tier?.type === "context");
  if (contextual) {
    const row = deriveBaseRow(contextual, { provider: "openai" });
    if (!row) {
      return null;
    }
    const size = Number(contextual.tier?.size);
    return { ...row, threshold: Number.isFinite(size) && size > 0 ? size : 272_000 };
  }
  const legacy = cost?.context_over_200k;
  if (legacy && (Number(legacy.input) > 0 || Number(legacy.output) > 0)) {
    const row = deriveBaseRow(legacy, { provider: "openai" });
    return row ? { ...row, threshold: 272_000 } : null;
  }
  return null;
}

function toCachedRow(model, { provider }) {
  const base = deriveBaseRow(model?.cost, { provider });
  if (!base) {
    return null;
  }
  const fastCost = model?.experimental?.modes?.fast?.cost;
  const fast = fastCost ? deriveFastRow(fastCost, { provider }) : null;
  const row = {
    label: typeof model?.name === "string" && model.name ? model.name : String(model?.id ?? ""),
    ...base,
    source: MODELS_DEV_PRICING_SOURCE,
  };
  const contextWindow = Number(model?.limit?.context);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    row.contextWindow = contextWindow;
  }
  const inputs = model?.modalities?.input;
  if (Array.isArray(inputs)) {
    row.imageInput = inputs.includes("image");
  }
  if (typeof model?.family === "string" && model.family) {
    row.family = model.family;
  }
  if (fast) {
    row.fast = fast;
  }
  if (provider === "openai") {
    const long = deriveLongTier(model?.cost);
    if (long) {
      row.long = long;
    }
  }
  return row;
}

/**
 * @param {string} raw models.dev api.json body
 * @returns {{ anthropic: Record<string, object>, openai: Record<string, object> } | null}
 */
export function parseModelsDevListPrices(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") {
    return null;
  }
  const rates = {};
  for (const provider of ["anthropic", "openai"]) {
    const models = doc[provider]?.models;
    if (!models || typeof models !== "object") {
      continue;
    }
    const table = {};
    for (const [id, model] of Object.entries(models)) {
      const key = String(id ?? "").toLowerCase().trim();
      if (!key) {
        continue;
      }
      const row = toCachedRow(model, { provider });
      if (row) {
        table[key] = row;
      }
    }
    if (Object.keys(table).length > 0) {
      rates[provider] = table;
    }
  }
  return Object.keys(rates).length > 0 ? rates : null;
}

/** @type {{ anthropic?: Record<string, object>, openai?: Record<string, object> } | null} */
let cachedRates = null;
// Mirrors the serverless cache: distinguishes "resolved (even null)" from
// "not yet loaded", so an explicit clear can't resurrect disk data.
let ratesResolved = false;

function cacheFile() {
  return scopedCacheFilePath("list-price-cache.json");
}

/**
 * @returns {{ cachedAt: number, rates: object | null } | null}
 */
export function readListPriceCache() {
  let raw;
  try {
    raw = readFileSync(cacheFile(), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || !value.rates || typeof value.rates !== "object") {
      return null;
    }
    const cachedAt = Number.isFinite(value.cachedAt) ? value.cachedAt : 0;
    return { cachedAt, rates: value.rates };
  } catch {
    return null;
  }
}

/** @returns {object | null} In-memory rates, lazy-loading the disk cache once. */
export function getListPriceRates() {
  if (!ratesResolved) {
    cachedRates = readListPriceCache()?.rates ?? null;
    ratesResolved = true;
  }
  return cachedRates;
}

/**
 * Re-read the persisted rates into memory, so a process polling for a
 * background refresh sees rows another process wrote. A missing/unreadable
 * file keeps the in-memory rates untouched. Total: never throws.
 */
export function reloadListPriceRates() {
  const rates = readListPriceCache()?.rates ?? null;
  if (rates) {
    cachedRates = rates;
  }
  ratesResolved = true;
  return cachedRates;
}

/** @param {"anthropic" | "openai"} provider @returns {Record<string, object>} */
export function cachedListRateTable(provider) {
  return getListPriceRates()?.[provider] ?? {};
}

/**
 * Set the in-memory rates, optionally persisting them for offline processes.
 * Tests use the memory-only form to avoid touching the disk cache.
 */
export function setListPriceCacheRates(rates, { persist = false } = {}) {
  cachedRates = rates;
  ratesResolved = true;
  if (persist && rates) {
    persistListPriceCache(rates);
  }
  return cachedRates;
}

/** Reset the in-memory rates without touching the disk cache. Safe anywhere. */
export function clearListPriceCache() {
  cachedRates = null;
  ratesResolved = true;
}

/**
 * Reset the in-memory rates AND delete the persisted cache file. Test-only:
 * call under a temp HOME (or the shared NEXUS_CACHE_DIR isolation) so a
 * spec never erases the developer's warmed snapshot.
 */
export function deletePersistedListPriceCache() {
  clearListPriceCache();
  try {
    rmSync(cacheFile(), { force: true });
  } catch {}
}

function persistListPriceCache(rates) {
  try {
    const file = cacheFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ cachedAt: Date.now(), rates }));
  } catch {
    // Best-effort — a failed persist must never break pricing lookups.
  }
}

/** Whether the persisted list-price cache is fresh enough to skip a refetch. */
export function isListPriceCacheFresh() {
  const cache = readListPriceCache();
  if (!cache?.rates) {
    return false;
  }
  return Date.now() - cache.cachedAt < catalogTtlMs();
}

/**
 * Best-effort refresh of the list-price cache from models.dev. Never throws:
 * failures keep the prior snapshot (or nothing) in place. Skipped entirely
 * under NEXUS_TEST so specs never touch the network.
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<boolean>} True when a usable cache exists afterwards.
 */
export async function refreshListPriceCache({ force = false } = {}) {
  if (process.env.NEXUS_TEST === "1") {
    return isListPriceCacheFresh() || getListPriceRates() !== null;
  }
  if (!force && isListPriceCacheFresh()) {
    return true;
  }
  const parsed = parseModelsDevListPrices(await fetchModelsDevApi());
  if (!parsed) {
    return getListPriceRates() !== null;
  }
  setListPriceCacheRates(parsed, { persist: true });
  return true;
}
