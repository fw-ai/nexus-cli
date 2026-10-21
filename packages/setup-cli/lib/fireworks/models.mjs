import {
  AUTO_INSTANT_MODEL_ID,
  AUTO_MODEL_ID,
  FIREROUTER_ROUTER_ID,
  OPENAI_MODEL_FAMILIES,
  canonicalAutoModelId,
  isFirerouterModel,
  isFirerouterModelPattern,
} from "./model-id.mjs";
import { MISSING_FIREWORKS_API_KEY_MESSAGE } from "../keys/key-type.mjs";
import {
  FIREWORKS_PRICING_DOCS_URL,
  lookupModelSpec,
  pricingMatchesModelRefTier,
  requiresFastTierPricing,
  resolveFireworksModelLabel,
  resolveRouterEntryDisplayName,
} from "./model-specs.mjs";
import {
  cacheServerlessCatalogSnapshot,
  getServerlessCatalogSnapshot,
  isCatalogCacheFresh,
  readCatalogCache,
  setServerlessCatalogSnapshot,
} from "./serverless-catalog-cache.mjs";
import { fireworksGatewayFetchSignal } from "./gateway-fetch.mjs";
import { stripViaFireworksSuffix } from "./label-suffix.mjs";
import { refreshListPriceCache } from "../pricing/list-price-cache.mjs";

export const FIREWORKS_GATEWAY_URL = "https://api.fireworks.ai";
export const PLATFORM_ACCOUNT_ID = "fireworks";
export const KIND_SERVERLESS = "serverless";
export const SERVERLESS_CODING_USE_CASE = "coding";
/** @typedef {{ id: string, shortId: string, displayName: string, baseModelId?: string, kind: "serverless", serverlessMode?: string }} CatalogEntry */

export function firerouterCatalogEntry() {
  return {
    id: FIREROUTER_ROUTER_ID,
    shortId: "firerouter",
    displayName: "FireRouter",
    kind: KIND_SERVERLESS,
  };
}

/**
 * Synthesized row for an auto mix. The serverless API never returns them, so
 * `model list` has to supply them to show the models at all.
 * @param {string} [modelId] an auto mix slug (`auto`, `auto-instant`)
 */
export function autoCatalogEntry(modelId = AUTO_MODEL_ID) {
  const autoId = canonicalAutoModelId(modelId) || AUTO_MODEL_ID;
  return {
    id: autoId,
    shortId: autoId,
    displayName: autoDisplayName(autoId),
    kind: KIND_SERVERLESS,
  };
}

export function shortIdFromResourceName(name) {
  if (typeof name !== "string" || !name) {
    return "";
  }
  const segments = name.split("/");
  return segments.at(-1) ?? name;
}

/**
 * Turn a model id into a human-readable name for display, without any network
 * call. e.g. `accounts/fireworks/models/glm-5p2` -> "GLM 5.2",
 * `accounts/fireworks/routers/glm-latest` -> "GLM Latest",
 * `kimi-k3-fast` -> "Kimi K3 Fast", `composer-2.5` -> "Composer 2.5".
 * Falls back to the last path segment if prettification yields nothing better.
 * @param {string} modelId
 * @returns {string}
 */
export function prettyModelName(modelId) {
  if (!modelId) {
    return "(unset)";
  }
  if (modelId === "default") {
    return "default";
  }
  const last = String(modelId).split("/").at(-1) ?? modelId;
  const tokens = last.split(/[-_]/).filter(Boolean);
  const pretty = tokens.map((tok) => {
    if (/^[a-z]+$/i.test(tok)) {
      // short all-letter tokens are acronyms (GLM); longer ones are names (Kimi, Qwen, Deepseek).
      // GPT family names are names however short (Sol, like Astra and Luna).
      const name = tok.length > 3 || OPENAI_MODEL_FAMILIES.includes(tok.toLowerCase());
      return name ? tok.charAt(0).toUpperCase() + tok.slice(1) : tok.toUpperCase();
    }
    let m = tok.match(/^([a-zA-Z])(\d+)p(\d+)$/); // k2p6 -> K2.6
    if (m) {
      return `${m[1].toUpperCase()}${m[2]}.${m[3]}`;
    }
    m = tok.match(/^(\d+)p(\d+)$/); // 5p2 -> 5.2
    if (m) {
      return `${m[1]}.${m[2]}`;
    }
    m = tok.match(/^v(\d+)$/i); // v4 -> V4
    if (m) {
      return `V${m[1]}`;
    }
    // mixed alphanumeric like "2.5" or "k25" — capitalise a leading letter
    return tok.charAt(0).toUpperCase() + tok.slice(1);
  });
  return pretty.join(" ");
}

/**
 * Human-readable label for an auto mix. Bare `auto` is "Auto"; variants use
 * pretty slugs (`auto-instant` -> "Auto Instant").
 * @param {string} modelId
 * @returns {string}
 */
export function autoDisplayName(modelId) {
  const slug = canonicalAutoModelId(modelId);
  if (!slug || slug === AUTO_MODEL_ID) {
    return lookupModelSpec(AUTO_MODEL_ID)?.label ?? "Auto";
  }
  return prettyModelName(slug);
}

/**
 * Human-readable label for a FireRouter selection. Bare `firerouter` renders as
 * "FireRouter"; a multi-model slug joins pretty model names with " · "
 * (firerouter/claude-opus-5/kimi-k3-fast -> "FireRouter · Claude Opus 5 · Kimi K3 Fast").
 * @param {string} modelId
 * @returns {string}
 */
export function firerouterDisplayName(modelId) {
  if (!isFirerouterModelPattern(modelId)) {
    return "FireRouter";
  }
  if (isFirerouterModel(modelId)) {
    return "FireRouter";
  }
  const stripped = String(modelId ?? "")
    .replace(/\[1m\]$/i, "")
    .replace(/^accounts\/fireworks\/(?:models|routers)\//i, "")
    .trim();
  const NOISE = new Set(["accounts", "fireworks", "models", "routers"]);
  const segments = stripped.split("/").filter(
    (part) => part && !part.startsWith("firerouter") && !NOISE.has(part.toLowerCase()),
  );
  if (segments.length === 0) {
    return "FireRouter";
  }
  return ["FireRouter", ...segments.map(prettyModelName)].join(" · ");
}

/** The gateway answered with a non-2xx status (as opposed to a failed request). */
class FireworksHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "FireworksHttpError";
    this.status = status;
  }
}

async function fetchGatewayPage(path, apiKey) {
  // Same dev/test override as verify-api-key.mjs — lets the mock gateway
  // serve the catalog in specs.
  const gatewayUrl = process.env.NEXUS_GATEWAY_URL?.trim() || FIREWORKS_GATEWAY_URL;
  // The serverless listing is read-only and occasionally returns a transient
  // 5xx ("Error listing serverless models" from the control plane). Retry once
  // so a single blip doesn't force every harness `on` into offline mode.
  // Only HTTP 5xx responses are retried: client errors are final, and network
  // errors propagate exactly as before this change — every caller degrades to
  // cache (loadServerlessCatalog serves the stale snapshot; Codex warns and
  // continues without catalog metadata), so retrying a 30s timeout here would
  // only double the offline wait before those fallbacks run.
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const response = await fetch(`${gatewayUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: fireworksGatewayFetchSignal(),
    });

    if (response.ok) {
      return response.json();
    }
    const body = (await response.text().catch(() => "")).trim();
    const detail = body ? `: ${body.slice(0, 200)}` : "";
    if (response.status === 401 || response.status === 403) {
      // A 403 can come from a network policy rather than a bad key.
      const rejected = response.status === 401 ? "the API key" : "the request";
      throw new FireworksHttpError(
        response.status,
        `Fireworks API rejected ${rejected} (${response.status}${detail}). `
        + "Check FIREWORKS_API_KEY and ensure the key can access account model listings.",
      );
    }
    lastError = new FireworksHttpError(
      response.status,
      `Fireworks API ${response.status} ${response.statusText}${detail}.`,
    );
    // Only retry server-side blips; client errors are final.
    if (response.status < 500 || response.status > 599) {
      throw lastError;
    }
  }
  throw lastError;
}

/**
 * Flat serverless rows carry the amount as a plain string ("1.4"); the nested
 * format used units/nanos. Accept both.
 * @param {string | number | { units?: string | number, nanos?: number }} [money]
 * @returns {number}
 */
export function moneyToUsd(money) {
  if (money === null || money === undefined) {
    return 0;
  }
  if (typeof money === "string" || typeof money === "number") {
    return Number(money) || 0;
  }
  const units = Number(money.units ?? 0);
  const nanos = Number(money.nanos ?? 0);
  return units + nanos / 1_000_000_000;
}

/**
 * @param {Array<{ sku?: string, amount?: { units?: string | number, nanos?: number } }>} skuInfos
 * @returns {{ input: number, cachedInput: number, output: number }}
 */
export function parseSkuPricing(skuInfos = []) {
  let input = 0;
  let cachedInput = 0;
  let output = 0;
  let legacyInput = 0;

  for (const sku of skuInfos) {
    const amount = moneyToUsd(sku.amount);
    switch (sku.sku) {
      case "LLM input tokens (uncached)":
        input = amount;
        break;
      case "LLM input tokens":
        legacyInput = amount;
        break;
      case "LLM input tokens (cached)":
        cachedInput = amount;
        break;
      case "LLM output tokens":
        output = amount;
        break;
      default:
        break;
    }
  }

  if (!input && legacyInput) {
    input = legacyInput;
  }

  return { input, cachedInput, output };
}

/**
 * True when the API response carries an explicit modality signal. Distinguishes
 * "the API says text-only" from "the API said nothing" so the cache never
 * fabricates a text-only default that would override a curated static spec.
 * @param {{ supportsImageInput?: boolean, supports_image_input?: boolean, inputModalities?: string[], input_modalities?: string[] }} model
 * @returns {boolean}
 */
export function hasModalitySignal(model) {
  const explicit = model.inputModalities ?? model.input_modalities;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return true;
  }
  return (model.supportsImageInput ?? model.supports_image_input) !== undefined;
}

/**
 * @param {{ supportsImageInput?: boolean, supports_image_input?: boolean, inputModalities?: string[], input_modalities?: string[] }} model
 * @returns {string[]}
 */
export function inputModalitiesFromModel(model) {
  const explicit = model.inputModalities ?? model.input_modalities;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit;
  }
  const mods = ["text"];
  if (model.supportsImageInput ?? model.supports_image_input) {
    mods.push("image");
  }
  return mods;
}

/**
 * Pricing tier of a flat serverless row, read off `serverless_mode`.
 * @param {{ serverless_mode?: string, serverlessMode?: string }} model
 * @returns {string}
 */
function flatModeTier(model) {
  const mode = model.serverless_mode ?? model.serverlessMode ?? "";
  if (mode === "fast") {
    return "fast";
  }
  if (mode === "priority") {
    return "priority";
  }
  return "standard";
}

function hasUsableSkuPricing(rates) {
  return rates.input > 0 || rates.output > 0;
}

function buildPricingRecord(id, label, rates, tier) {
  if (!hasUsableSkuPricing(rates)) {
    return null;
  }
  return {
    slug: shortIdFromResourceName(id),
    label: stripViaFireworksSuffix(label),
    input: rates.input,
    cachedInput: rates.cachedInput,
    output: rates.output,
    tier,
    source: FIREWORKS_PRICING_DOCS_URL,
  };
}

/** Newer `created` first; null timestamps sort last, then by shortId. */
export function byRecencyThenShortId(left, right) {
  const l = left?.created ?? 0;
  const r = right?.created ?? 0;
  if (l !== r) {
    return r - l;
  }
  return (left?.shortId ?? "").localeCompare(right?.shortId ?? "");
}

/**
 * The full list of individual (non-router) models in the catalog, newest
 * first. No family collapsing: every version the API serves stays visible.
 * @param {import("./models.mjs").CatalogEntry[]} catalog
 * @returns {import("./models.mjs").CatalogEntry[]}
 */
export function allModelsByRecency(catalog) {
  return catalog
    .filter((entry) => entry.id?.includes("/models/"))
    .sort(byRecencyThenShortId);
}

function normalizeModelEntry(model) {
  const name = model.name ?? model.id ?? "";
  if (!name.includes("/models/")) {
    return null;
  }

  return {
    id: name,
    shortId: shortIdFromResourceName(name),
    displayName: stripViaFireworksSuffix(
      lookupModelSpec(name)?.label
        ?? model.display_name
        ?? model.displayName
        ?? prettyModelName(name),
    ),
    kind: KIND_SERVERLESS,
    // Flat rows carry a `created` epoch seconds stamp — used to sort the
    // model list newest-first.
    created: typeof model.created === "number" ? model.created * 1000 : null,
  };
}

function normalizeRouterEntry({ usageId, baseModel }) {
  const displayName = prettyModelName(usageId);
  return {
    id: usageId,
    shortId: shortIdFromResourceName(usageId),
    displayName,
    baseModelId: baseModel.name ?? baseModel.id,
    kind: KIND_SERVERLESS,
    serverlessMode: baseModel.serverless_mode ?? baseModel.serverlessMode ?? "",
  };
}

// Alias router rows now come straight from the API: each serverless entry may
// carry `aliases` — full router resource names (`accounts/fireworks/routers/…`)
// pointing at this entry as its target. No static mapping or fallback logic;
// an alias the API doesn't report simply isn't offered. Runs once per model,
// after all mode rows are processed, so an alias can borrow the tier-appropriate
// row's rates: a fast-latest alias takes the fast router's pricing, a plain
// -latest alias takes the base model's standard rates.
function addApiAliasRouters(snapshot, baseModelId, aliases, entries, pricingById, fastRouterId) {
  const modalities = snapshot.inputModalitiesById.get(baseModelId);
  const contextLength = snapshot.contextLengthById.get(baseModelId);
  const supportsTools = snapshot.supportsToolsById.get(baseModelId);
  const basePricing = pricingById.get(baseModelId);

  for (const aliasRouterId of aliases) {
    if (typeof aliasRouterId !== "string" || !aliasRouterId.includes("/routers/")) {
      continue;
    }
    const shortId = shortIdFromResourceName(aliasRouterId);
    entries.push({
      id: aliasRouterId,
      shortId,
      displayName: prettyModelName(aliasRouterId),
      baseModelId,
      kind: KIND_SERVERLESS,
    });
    snapshot.routerBaseModelById.set(aliasRouterId, baseModelId);

    // Mirror the base model's metadata onto the alias so context/modality/
    // tool lookups resolve without a second fetch. Pricing only lands on the
    // alias when the alias's expected tier matches (a fast-latest alias
    // borrows the fast mode router's rates, never the base model's standard
    // ones), and the label carries the same fast/latest suffix policy as
    // entry display names.
    const wantsFast = requiresFastTierPricing(shortId);
    const sourcePricing = wantsFast
      ? (fastRouterId ? pricingById.get(fastRouterId) : undefined)
      : basePricing;
    if (sourcePricing && pricingMatchesModelRefTier(shortId, sourcePricing)) {
      pricingById.set(aliasRouterId, {
        ...sourcePricing,
        slug: shortId,
        label: resolveRouterEntryDisplayName(aliasRouterId, sourcePricing.label),
      });
    }
    if (modalities) {
      snapshot.inputModalitiesById.set(aliasRouterId, modalities);
    }
    if (contextLength) {
      snapshot.contextLengthById.set(aliasRouterId, contextLength);
    }
    if (supportsTools !== undefined) {
      snapshot.supportsToolsById.set(aliasRouterId, supportsTools);
    }
  }
}

function refreshRouterDisplayNames(snapshot) {
  const priorSnapshot = getServerlessCatalogSnapshot();
  setServerlessCatalogSnapshot(snapshot);
  try {
    for (const entry of snapshot.entries) {
      if (!entry.baseModelId) {
        continue;
      }
      entry.displayName = resolveFireworksModelLabel(entry.id) ?? entry.displayName;
    }
  } finally {
    setServerlessCatalogSnapshot(priorSnapshot);
  }
}

/**
 * Build the catalog snapshot from flat `/v1/serverless/models` rows. Each row
 * is one (model, serverless_mode) pair; `usage_identifier` carries the mode's
 * router and `aliases` lists the stable `-latest` router aliases whose target
 * is this row's model.
 * @param {object[]} apiModels
 */
export function buildServerlessCatalogSnapshot(apiModels) {
  const entries = [];
  const pricingById = new Map();
  const inputModalitiesById = new Map();
  const routerBaseModelById = new Map();
  const contextLengthById = new Map();
  const supportsToolsById = new Map();
  const snapshot = {
    entries,
    pricingById,
    inputModalitiesById,
    routerBaseModelById,
    contextLengthById,
    supportsToolsById,
  };
  const seenModelIds = new Set();
  // Every alias the API reported per model, plus the id of each model's
  // fast-mode router (`usage_identifier` of its fast row) — alias synthesis
  // runs once per model after the row loop, borrowing rates from the model's
  // own mode routers, never a same-family sibling's.
  const aliasRowsByModel = new Map();
  const fastRouterByModel = new Map();

  for (const model of apiModels) {
    const modelId = model.name ?? model.id ?? "";
    const tier = flatModeTier(model);
    const modelEntry = normalizeModelEntry(model);
    if (!modelEntry) {
      continue;
    }
    // The cache must hold only facts the API actually reports. Fabricating a
    // default (tool support = true, modalities = text-only) and caching it lets
    // the cache silently override curated static specs — e.g. flipping
    // gpt-oss-20b's toolCalling:false to true, or a vision model to text-only.
    // Absence means "unknown" so lookups fall back to the spec.
    const modalities = hasModalitySignal(model) ? inputModalitiesFromModel(model) : null;
    const contextLength = model.contextLength ?? model.context_length ?? 0;
    const supportsTools = model.supportsTools ?? model.supports_tools ?? null;

    if (!seenModelIds.has(modelId)) {
      seenModelIds.add(modelId);
      entries.push(modelEntry);
      if (modalities) {
        inputModalitiesById.set(modelId, modalities);
      }
      if (contextLength) {
        contextLengthById.set(modelId, contextLength);
      }
      if (supportsTools !== null) {
        supportsToolsById.set(modelId, supportsTools);
      }
    }
    if (Array.isArray(model.aliases) && model.aliases.length > 0) {
      // Different mode rows may report different aliases for one model
      // (e.g. the fast row carries `*-fast-latest`); union them so no
      // mode-row's aliases are lost.
      const merged = aliasRowsByModel.get(modelId) ?? [];
      aliasRowsByModel.set(modelId, [...new Set([...merged, ...model.aliases])]);
    }

    // Bare model ids carry standard-tier pricing only; a mode-specific rate
    // belongs to that mode's usage_identifier router below.
    const rates = tier === "priority" ? null : parseSkuPricing(model.pricing ?? []);
    if (tier === "standard" && rates) {
      const pricing = buildPricingRecord(modelId, modelEntry.displayName, rates, tier);
      if (pricing) {
        pricingById.set(modelId, pricing);
      }
    }

    const usageId = model.usageIdentifier ?? model.usage_identifier ?? "";
    if (usageId.includes("/routers/")) {
      const routerEntry = normalizeRouterEntry({ usageId, baseModel: model });
      entries.push(routerEntry);
      routerBaseModelById.set(usageId, modelId);
      if (tier === "fast") {
        fastRouterByModel.set(modelId, usageId);
      }
      if (rates) {
        const pricing = buildPricingRecord(usageId, routerEntry.displayName, rates, tier);
        if (pricing) {
          pricingById.set(usageId, pricing);
        }
      }
      if (modalities) {
        inputModalitiesById.set(usageId, modalities);
      }
      if (contextLength) {
        contextLengthById.set(usageId, contextLength);
      }
      if (supportsTools !== null) {
        supportsToolsById.set(usageId, supportsTools);
      }
    }
  }

  for (const [modelId, aliases] of aliasRowsByModel) {
    addApiAliasRouters(snapshot, modelId, aliases, entries, pricingById, fastRouterByModel.get(modelId));
  }

  // An auto mix routes across models, so it must not inherit the rates,
  // context, or base model of whichever row listed it; its static spec stays
  // the source for those.
  for (const entry of entries) {
    if (autoCatalogEntryId(entry)) {
      for (const byId of [pricingById, inputModalitiesById, routerBaseModelById, contextLengthById, supportsToolsById]) {
        byId.delete(entry.id);
      }
    }
  }

  snapshot.entries = dedupeCatalog(entries);
  refreshRouterDisplayNames(snapshot);
  return snapshot;
}

function dedupeCatalog(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (!entry?.id) {
      continue;
    }
    // The gateway serves auto mixes under the bare slug only, so a listed
    // auto row (a router, a model, or an alias on several models) collapses
    // to the one canonical row the synthesized entry would have been.
    const autoId = autoCatalogEntryId(entry);
    if (autoId === AUTO_INSTANT_MODEL_ID) {
      continue; // Retired mix: never enters a snapshot.
    }
    if (autoId) {
      byId.set(autoId, autoCatalogEntry(autoId));
      continue;
    }
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => a.shortId.localeCompare(b.shortId));
}

export async function fetchServerlessCatalog(apiKey) {
  const models = await fetchServerlessCatalogRaw(apiKey);
  const snapshot = buildServerlessCatalogSnapshot(models);
  const updatedAt = cacheServerlessCatalogSnapshot(snapshot);
  return {
    catalog: snapshot.entries,
    rawModels: models,
    routersUnavailable: false,
    updatedAt,
  };
}

/**
 * Populate pricing/modality cache from the serverless API. Swallows errors.
 *
 * Only genuine Fireworks inference keys (`fw_`) are sent to api.fireworks.ai,
 * so a foreign credential (e.g. an Anthropic key read from ANTHROPIC_API_KEY)
 * never reaches the Fireworks gateway.
 */
export async function warmServerlessPricingCache(apiKey) {
  // Anthropic/OpenAI list prices come from the keyless models.dev cache, so
  // they refresh for every key ahead of the fw_ gate.
  await refreshListPriceCache();
  const trimmed = apiKey?.trim();
  if (!trimmed || !trimmed.startsWith("fw_")) {
    return;
  }
  try {
    await fetchServerlessCatalog(trimmed);
  } catch {
    /* static spec fallbacks */
  }
}

export function buildPickerCatalogFromApiModels(apiModels) {
  const snapshot = buildServerlessCatalogSnapshot(apiModels);
  setServerlessCatalogSnapshot(snapshot);
  return snapshot.entries;
}

export async function fetchServerlessCatalogRaw(apiKey) {
  const models = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({ use_cases: SERVERLESS_CODING_USE_CASE });
    if (pageToken) {
      query.set("pageToken", pageToken);
    }
    const page = await fetchGatewayPage(`/v1/serverless/models?${query}`, apiKey);
    models.push(...(page.data ?? []));
    pageToken = page.nextPageToken ?? page.next_page_token ?? "";
  } while (pageToken);

  return models;
}

export function filterCatalogBySearch(catalog, search = "") {
  const query = search.trim().toLowerCase();
  if (!query) {
    return catalog;
  }

  return catalog.filter((entry) => (
    entry.shortId.toLowerCase().includes(query)
    || entry.displayName.toLowerCase().includes(query)
    || entry.id.toLowerCase().includes(query)
  ));
}

// Alias suffixes whose prefix names a model family (kimi-fast-latest → kimi).
const LATEST_ALIAS_SUFFIXES = ["-fast-latest", "-latest"];

// Version extraction is deliberately permissive: any digit-bearing segment is
// version-shaped, whatever the vendor's marker convention (k3, v4, m2p7, 5p2,
// qwen3p7, 0731, 1.5, a1b2, …). The one carve-out is parameter sizes
// (7b, 20b, 120b, 1p5b, 135m): those name a distinct model, not a version, so
// gpt-oss-20b and gpt-oss-120b must never collapse into one family.
const PARAM_SIZE_SEGMENT_RE = /^\d+(?:[p.]\d+)?[bm]$/i;
const LEADING_ALPHA_RE = /^[a-z]+/i;

function versionNumbers(text) {
  return (text.match(/\d+/g) ?? []).map(Number);
}

/**
 * Strip version-shaped segments from a slug to recover its family name,
 * collecting the digits as a comparable version vector. A multi-letter alpha
 * prefix on a digit-bearing segment is part of the family (qwen3p7 → qwen);
 * a single letter is a version marker and goes with the digits (k3, v4, m2p7).
 * Works for arbitrary families without per-vendor rules: glm-5p2 → glm [5,2],
 * kimi-k3 → kimi [3], qwen3p7-plus → qwen-plus [3,7],
 * deepseek-v4-flash-0731 → deepseek-flash [4,731],
 * modelfamily-a1b2-abvc → modelfamily-abvc [1,2].
 */
function stripVersionSegments(shortId) {
  const literals = [];
  const version = [];
  for (const segment of shortId.split("-")) {
    if (!/\d/.test(segment) || PARAM_SIZE_SEGMENT_RE.test(segment)) {
      literals.push(segment);
      continue;
    }
    version.push(...versionNumbers(segment));
    const prefix = segment.match(LEADING_ALPHA_RE)?.[0] ?? "";
    if (prefix.length > 1) {
      literals.push(prefix);
    }
  }
  return { family: literals.join("-"), version };
}

/** Family prefix of a `-latest` / `-fast-latest` alias slug, else null. */
function latestAliasFamily(shortId) {
  for (const suffix of LATEST_ALIAS_SUFFIXES) {
    if (shortId.endsWith(suffix) && shortId.length > suffix.length) {
      return shortId.slice(0, -suffix.length);
    }
  }
  return null;
}

/**
 * { family, version, latest } for a catalog shortId. `aliasFamilies` — the
 * normalized families of the catalog's own -latest aliases — lets variants
 * whose trailing suffix isn't version-shaped (kimi-k2p7-code, glm-5p1-fast)
 * still land in the family their alias advertises, and lets a base model
 * whose slug exactly equals the alias family (kimi-k3 vs kimi-latest,
 * modelfamily-a1b2-abvc vs modelfamily-a1b2-abvc-latest) collapse into it.
 * Resolution: exact alias-family match first, then longest alias-family
 * prefix; otherwise the stripped family stands alone.
 */
function catalogFamilyVersion(shortId = "", aliasFamilies = []) {
  const aliasFamily = latestAliasFamily(shortId);
  if (aliasFamily !== null) {
    return { family: stripVersionSegments(aliasFamily).family, version: [], latest: true };
  }
  const { family, version } = stripVersionSegments(shortId);
  // Geography is a serving constraint, not a model-family variant. Keep a US
  // router separate from the global family so `*-latest` does not collapse it.
  if (shortId.endsWith("-us")) {
    return { family, version, latest: false };
  }
  if (aliasFamilies.includes(family)) {
    return { family, version, latest: false };
  }
  const prefixed = aliasFamilies
    .filter((candidate) => family.startsWith(`${candidate}-`))
    .sort((a, b) => b.length - a.length)[0];
  return { family: prefixed ?? family, version, latest: false };
}

function compareVersions(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Keep the stable aliases users should pin in harness pickers. For each known
 * versioned family:
 *   1. keep `*-latest` and `*-fast-latest` aliases when present;
 *   2. otherwise keep every variant of only the newest concrete version.
 * Standalone/non-versioned models remain untouched.
 * @param {import("./models.mjs").CatalogEntry[]} catalog
 * @returns {import("./models.mjs").CatalogEntry[]}
 */
/**
 * Families this catalog's own `-latest` alias rows advertise, so versioned
 * entries (including families this CLI has never seen) resolve against them.
 */
function catalogAliasFamilies(catalog) {
  return [...new Set(
    catalog
      .map((entry) => latestAliasFamily(entry.shortId ?? ""))
      .filter((family) => family !== null)
      .map((family) => stripVersionSegments(family).family),
  )];
}

function parseCatalogFamilies(catalog) {
  const aliasFamilies = catalogAliasFamilies(catalog);
  return catalog.map((entry) => ({
    entry,
    ...catalogFamilyVersion(entry.shortId, aliasFamilies),
  }));
}

/** Highest version vector seen per family among concrete (non-alias) entries. */
function newestVersionByFamily(parsed) {
  const newestByFamily = new Map();
  for (const { family, version, latest } of parsed) {
    if (latest || version.length === 0) continue;
    const current = newestByFamily.get(family);
    if (!current || compareVersions(version, current) > 0) {
      newestByFamily.set(family, version);
    }
  }
  return newestByFamily;
}

export function preferLatestAliases(catalog) {
  const parsed = parseCatalogFamilies(catalog);
  const aliasedFamilies = new Set(
    parsed.filter(({ latest }) => latest).map(({ family }) => family),
  );
  const newestByFamily = newestVersionByFamily(parsed);

  return parsed
    .filter(({ family, version, latest }) => {
      if (latest) return true;
      if (aliasedFamilies.has(family)) return false;
      const newest = newestByFamily.get(family);
      return !newest || compareVersions(version, newest) === 0;
    })
    .map(({ entry }) => entry);
}

/**
 * Preferred model ids for harness provider catalogs. The served catalog
 * already carries the `auto` mix (see `loadServerlessCatalog`); FireRouter is
 * included only when explicitly requested via `on --model firerouter`.
 * @param {import("./models.mjs").CatalogEntry[]} catalog
 * @param {{ includeFirerouter?: boolean }} [opts]
 * @returns {string[]}
 */
export function registerableModelIds(catalog, { includeFirerouter = false } = {}) {
  return catalogWithAutomaticFirerouter(
    preferLatestAliases(catalog),
    { includeFirerouter },
  )
    // The retired `auto-instant` mix never registers, even when the
    // gateway still returns its row.
    .filter((entry) => autoCatalogEntryId(entry) !== AUTO_INSTANT_MODEL_ID)
    .map((entry) => entry.id);
}

/**
 * Whether a catalog row is one of the auto mixes, by either the short id or
 * the final segment of the resource name. The served catalog carries them as
 * list members; display passes split them back out (`model list` sections,
 * the Claude picker).
 * @param {CatalogEntry} entry
 */
export function isAutoCatalogEntry(entry) {
  return autoCatalogEntryId(entry) !== "";
}

/**
 * The canonical auto mix slug a catalog row stands for (`auto`,
 * `auto-instant`), or "" for any other row.
 * @param {CatalogEntry} entry
 */
export function autoCatalogEntryId(entry) {
  return canonicalAutoModelId(entry?.shortId) || canonicalAutoModelId(shortIdFromResourceName(entry?.id));
}

export function catalogWithAutomaticFirerouter(catalog, { includeFirerouter = false } = {}) {
  const withoutFirerouter = catalog.filter((entry) => entry.id !== FIREROUTER_ROUTER_ID);
  if (!includeFirerouter) {
    return withoutFirerouter;
  }
  // The catalog carried its own firerouter row: keep it in place rather than
  // prepending a synthesized duplicate.
  if (withoutFirerouter.length !== catalog.length) {
    return catalog;
  }
  return [firerouterCatalogEntry(), ...withoutFirerouter];
}

/**
 * Treat the `auto` mix like a serverless list member. The gateway serves it
 * without listing it, so the served catalog synthesizes the row once, up
 * front — every `on` path below (`registerableModelIds`, the Codex bundle,
 * `model list`, the Claude picker) then receives it like any other entry.
 * Empty lists stay empty so an unreachable catalog still reads as
 * unavailable (and model validation keeps skipping it) instead of
 * validating against a one-row list.
 * @param {import("./models.mjs").CatalogEntry[]} catalog
 * @returns {import("./models.mjs").CatalogEntry[]}
 */
export function catalogWithAutomaticAuto(catalog) {
  if (catalog.length === 0) {
    return catalog;
  }
  const canonical = withCanonicalAutoRows(catalog);
  if (canonical.some((entry) => entry.id === AUTO_MODEL_ID)) {
    return canonical;
  }
  return [autoCatalogEntry(), ...canonical];
}

/**
 * One canonical row per auto mix, in first-seen position. A snapshot cached
 * before the build-time dedupe can still carry the gateway's own auto rows.
 * @param {CatalogEntry[]} catalog
 */
function withCanonicalAutoRows(catalog) {
  const seen = new Set();
  const rows = [];
  let changed = false;
  for (const entry of catalog) {
    const autoId = autoCatalogEntryId(entry);
    if (autoId === AUTO_INSTANT_MODEL_ID) {
      // Retired mix: dropped from every canonical catalog/snapshot.
      changed = true;
      continue;
    }
    if (!autoId) {
      rows.push(entry);
    } else if (seen.has(autoId)) {
      changed = true;
    } else {
      seen.add(autoId);
      const canonical = entry.id === autoId && entry.shortId === autoId;
      changed ||= !canonical;
      rows.push(canonical ? entry : autoCatalogEntry(autoId));
    }
  }
  return changed ? rows : catalog;
}

export async function loadRegisterableModels({ apiKey, includeFirerouter = false }) {
  const { catalog, source } = await loadServerlessCatalog({ apiKey, refresh: true });
  const ids = registerableModelIds(catalog, { includeFirerouter });
  return { ids, available: source !== "stale" };
}

export async function loadServerlessCatalog({ apiKey, refresh = false }) {
  const resolvedKey = apiKey;
  if (!resolvedKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  // Eligible commands (harness `on`, `model list`, the Claude picker) all load
  // through here and therefore share this TTL-bounded cache: a fresh persisted
  // snapshot is served without a network round-trip, a stale one is refreshed,
  // and offline we reuse whatever is cached so the picker is never wiped. Only
  // a true cold start (no cache + unreachable network) is an error.
  //
  // `refresh` (model list --refresh) ignores the TTL so a still-fresh snapshot
  // can't short-circuit the fetch. The old snapshot is kept until a successful
  // fetch replaces it: deleting it up front would turn an offline refresh into
  // a cold start and wipe a catalog the user still depends on.
  const cache = readCatalogCache();
  if (!refresh && cache && isCatalogCacheFresh()) {
    // Serve from disk AND hydrate the in-memory snapshot, so downstream
    // catalog consumers (getServerlessCatalogSnapshot) see it even if this
    // process previously resolved the snapshot to null.
    setServerlessCatalogSnapshot(cache.snapshot);
    return {
      apiKey: resolvedKey,
      catalog: catalogWithAutomaticAuto(cache.snapshot.entries),
      rawModels: [],
      routersUnavailable: false,
      source: "cache",
      updatedAt: cache.cachedAt || null,
    };
  }

  try {
    // Every harness `on` loads the catalog through here, so refresh the
    // models.dev list prices alongside it rather than per-harness: a catalog
    // fetch and a price refresh are the same "metadata is fresh" moment. The
    // refresh is best-effort (never throws, keyless, TTL-bounded) and is not
    // awaited — the catalog path must not block on a slow/unreachable
    // models.dev. The fresh prices land on disk for the next read.
    void refreshListPriceCache({ force: refresh });
    const { catalog, rawModels, routersUnavailable, updatedAt } = await fetchServerlessCatalog(resolvedKey);
    return {
      apiKey: resolvedKey,
      catalog: catalogWithAutomaticAuto(catalog),
      rawModels,
      routersUnavailable,
      source: "network",
      updatedAt,
    };
  } catch (error) {
    if (cache?.snapshot) {
      setServerlessCatalogSnapshot(cache.snapshot);
      return {
        apiKey: resolvedKey,
          catalog: catalogWithAutomaticAuto(cache.snapshot.entries),
        rawModels: [],
        routersUnavailable: false,
        source: "stale",
        updatedAt: cache.cachedAt || null,
      };
    }
    const reason = error instanceof FireworksHttpError
      ? error.message
      : `Couldn't reach Fireworks (${error?.message || "network error"}). Check your network connection.`;
    const retry = error instanceof FireworksHttpError && error.status >= 500
      ? "Retry once the Fireworks API recovers. "
      : "";
    throw new Error(
      `Couldn't fetch the Fireworks model catalog and no cached copy exists yet. ${reason} ${retry}`
      + "Once `nexus model list` succeeds, the catalog is cached for offline use.",
      { cause: error },
    );
  }
}
