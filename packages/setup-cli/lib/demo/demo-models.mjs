/**
 * Unified model catalog for `nexus demo` — any two models can race.
 *
 * Includes Fireworks serverless models (with the `auto` mix) and Claude Code
 * Anthropic subscription slots (opus / sonnet / haiku / fable). Anthropic
 * slots require `nexus claude` (same routing check as status). FireRouter
 * routes are retired and are not offered.
 */

import {
  FIREROUTER_ROUTER_ID,
  isAutoModelId,
  isFirerouterModelPattern,
} from "../fireworks/model-id.mjs";
import {
  FIREWORKS_MODEL_SPECS,
  KNOWN_LATEST_ROUTER_ALIASES,
  catalogCacheCandidates,
  isUsableCachedServerlessPricing,
  resolveFireworksModelLabel,
} from "../fireworks/model-specs.mjs";
import {
  getServerlessCatalogSnapshot,
  lookupCachedServerlessPricing,
  lookupCatalogEntryById,
} from "../fireworks/serverless-catalog-cache.mjs";
import { lookupFireworksPricing } from "../fireworks/pricing.mjs";
import {
  firerouterDisplayName,
  preferLatestAliases,
} from "../fireworks/models.mjs";
import { prettyClaudeLabel, providerListPricing } from "./incumbent-detect.mjs";

/** Claude Code subscription aliases — routed through Fireworks when fireconnected. */
export const ANTHROPIC_SLOT_IDS = Object.freeze(["opus", "sonnet", "haiku", "fable"]);

/**
 * Concrete canonical Anthropic model ids for each slot — the Claude 5 family
 * (mid-2026). The demo's incumbent side races REAL Anthropic by passing these to
 * `claude -p --model`, which bypasses the `ANTHROPIC_DEFAULT_*_MODEL` alias
 * expansion (so the user's nexus slot pin doesn't redirect the incumbent
 * to a Fireworks backend). The request still routes through the Fireworks AI
 * gateway via the live `ANTHROPIC_BASE_URL` + Fireworks key — the gateway serves
 * real Anthropic models by concrete id, no separate Anthropic credential needed.
 * Single source of truth for both `demoCliModel` (routing) and `demoModelRates`
 * (pricing) so the cost estimate matches what actually runs.
 */
export const ANTHROPIC_SLOT_CONCRETE_IDS = Object.freeze({
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
});

// Labels include the version, matching the concrete id that actually runs
// (claude-opus-5 etc.) so two different Anthropic sides are distinguishable.
const ANTHROPIC_SLOT_LABELS = Object.freeze({
  opus: "Claude Opus 5",
  sonnet: "Claude Sonnet 5",
  haiku: "Claude Haiku 4.5",
  fable: "Claude Fable 5.1",
});

const DEFAULT_LEFT_MODEL = "opus";
const DEFAULT_RIGHT_MODEL = "glm-fast-latest";

/** @type {string[] | null} */
let demoPickerFireworksIds = null;

function isDemoLatestRouterShortId(shortId) {
  return shortId.endsWith("-fast-latest")
    || (shortId.endsWith("-latest") && !shortId.endsWith("-fast-latest"));
}

/** @param {string} shortId */
function demoPickerSortKey(shortId) {
  if (shortId === "auto") {
    return "0";
  }
  if (shortId.endsWith("-fast-latest")) {
    return `1:${shortId.slice(0, -"-fast-latest".length)}:0:${shortId}`;
  }
  if (shortId.endsWith("-latest")) {
    return `1:${shortId.slice(0, -"-latest".length)}:1:${shortId}`;
  }
  return `2:${shortId}`;
}

/** Offline fallback when the serverless catalog has not been warmed yet. */
function staticDemoFireworksPickerIds() {
  const latestAliases = [...KNOWN_LATEST_ROUTER_ALIASES]
    .filter(isDemoLatestRouterShortId)
    .sort((left, right) => demoPickerSortKey(left).localeCompare(demoPickerSortKey(right)));
  return ["auto", ...latestAliases];
}

/**
 * Derive demo picker ids from a serverless catalog snapshot (same source as
 * `nexus model list`). Keeps the `auto` mix and `*-latest` / `*-fast-latest`
 * routers only — pinned family versions like glm-5p1 are dropped by
 * `preferLatestAliases` when stable aliases exist. FireRouter rows are
 * filtered out even when the gateway still returns them.
 * @param {import("../fireworks/models.mjs").CatalogEntry[]} entries
 * @returns {string[]}
 */
export function demoFireworksPickerIdsFromCatalog(entries) {
  const supported = entries.filter((entry) => (
    !isFirerouterModelPattern(entry?.shortId ?? "")
    && !isFirerouterModelPattern(entry?.id ?? "")
  ));
  const trimmed = preferLatestAliases(supported);
  const ids = trimmed
    .map((entry) => entry.shortId)
    .filter((shortId) => shortId === "auto" || isDemoLatestRouterShortId(shortId));
  return [...new Set(["auto", ...ids])].sort((left, right) => (
    demoPickerSortKey(left).localeCompare(demoPickerSortKey(right))
  ));
}

/** Refresh picker ids from the warmed serverless catalog snapshot, if any. */
export function refreshDemoPickerFromServerlessCatalog() {
  const entries = getServerlessCatalogSnapshot()?.entries ?? [];
  demoPickerFireworksIds = entries.length > 0
    ? demoFireworksPickerIdsFromCatalog(entries)
    : null;
}

/** @returns {string[]} */
export function demoFireworksPickerIds() {
  return demoPickerFireworksIds ?? staticDemoFireworksPickerIds();
}

/** @param {string} id */
function demoFireworksKind(id) {
  return id === "firerouter" || isFirerouterModelPattern(id) ? "firerouter" : "fireworks";
}

/**
 * @typedef {"anthropic" | "fireworks" | "firerouter"} DemoModelKind
 * @typedef {{ id: string, label: string, kind: DemoModelKind }} DemoModelEntry
 */

/** @returns {DemoModelEntry[]} */
export function demoModelCatalog() {
  /** @type {DemoModelEntry[]} */
  const out = [];
  for (const id of ANTHROPIC_SLOT_IDS) {
    out.push({ id, label: ANTHROPIC_SLOT_LABELS[id], kind: "anthropic" });
  }
  const seen = new Set(out.map((e) => e.id));
  for (const id of demoFireworksPickerIds()) {
    if (seen.has(id)) continue;
    out.push({
      id,
      label: demoModelLabel(id),
      kind: demoFireworksKind(id),
    });
    seen.add(id);
  }
  return out;
}

/** @param {string} id */
export function isAnthropicSlotModel(id) {
  return ANTHROPIC_SLOT_IDS.includes(String(id).trim().toLowerCase());
}

/** @param {string} id */
export function isDemoCatalogModel(id) {
  return demoModelCatalog().some((e) => e.id === id);
}

/** @param {string} id */
export function demoModelLabel(id) {
  const bare = String(id).trim();
  if (isAnthropicSlotModel(bare)) {
    return ANTHROPIC_SLOT_LABELS[bare] ?? prettyClaudeLabel(bare);
  }
  const catalogEntry = lookupCatalogEntryById(bare)
    ?? lookupCatalogEntryById(`accounts/fireworks/routers/${bare}`);
  if (catalogEntry?.displayName) {
    return catalogEntry.displayName;
  }
  const resolved = resolveFireworksModelLabel(bare);
  if (resolved) {
    return resolved;
  }
  if (isFirerouterModelPattern(bare)) {
    return firerouterDisplayName(bare);
  }
  return FIREWORKS_MODEL_SPECS[bare]?.label ?? bare;
}

function hasLiveCachedPricing(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const cached = lookupCachedServerlessPricing(candidate);
    if (isUsableCachedServerlessPricing(modelRef, cached)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {NonNullable<ReturnType<typeof lookupFireworksPricing>>} pricing
 * @param {{ label: string, pricingRef: string }} opts
 */
function toDemoRateShape(pricing, { label, pricingRef }) {
  const live = hasLiveCachedPricing(pricingRef);
  const estimated = !live;
  return {
    inputPerMillion: pricing.input,
    outputPerMillion: pricing.output,
    cachedInputPerMillion: pricing.cachedInput,
    tier: pricing.tier ?? "standard",
    source: pricing.source,
    label,
    ...(estimated ? { estimated: true } : {}),
  };
}

/**
 * Unpriced shape for a delegating router: no pre-run cost, priced after the
 * run from the backend model that actually served the request.
 * @param {string} id
 * @param {string} labelPrefix Optional "Claude Opus (via …)" prefix for slots.
 */
function unpricedRouterRates(id, labelPrefix = null) {
  return {
    inputPerMillion: null,
    outputPerMillion: null,
    cachedInputPerMillion: null,
    cacheWrite1hPerMillion: null,
    cacheWrite5mPerMillion: null,
    cacheReadPerMillion: null,
    tier: "unpriced",
    source: "",
    label: labelPrefix
      ? `${labelPrefix} (via ${demoModelLabel(id)})`
      : demoModelLabel(id),
    estimated: true,
  };
}

/**
 * Resolve FireRouter pricing. FireRouter is a delegating router with no
 * per-token price of its own. If the catalog does not publish a rate for the
 * selected router, leave the pre-run rate unavailable; the demo runner prices
 * the backend model that actually served the request once usage arrives.
 *
 * Shared by the top-level `firerouter` demo id and by Anthropic slots whose
 * pinned backend is FireRouter (e.g. `opus` -> `firerouter[1m]`).
 * @param {string} id
 * @param {string} labelPrefix Optional "Claude Opus (via …)" prefix for slots.
 * @returns {{ inputPerMillion: number | null, outputPerMillion: number | null, cachedInputPerMillion: number | null, cacheWrite1hPerMillion: number | null, cacheWrite5mPerMillion: number | null, cacheReadPerMillion: number | null, tier: string, source: string, label: string, estimated: boolean } | null}
 */
function firerouterRates(id, labelPrefix = null) {
  const p = lookupFireworksPricing(id)
    ?? lookupFireworksPricing(FIREROUTER_ROUTER_ID);
  if (p) {
    return toDemoRateShape(p, {
      label: labelPrefix ? `${labelPrefix} (via ${p.label})` : p.label,
      pricingRef: id,
    });
  }
  return unpricedRouterRates(id, labelPrefix);
}

/**
 * Resolve `auto`-mix pricing. The mixes are delegating routers like FireRouter,
 * but they are not FireRouter: a published FireRouter catalog rate must never
 * stand in for them, so they skip the `FIREROUTER_ROUTER_ID` fallback and stay
 * unpriced until the run prices the serving backend.
 * @param {string} id
 */
function autoMixRates(id) {
  return unpricedRouterRates(id);
}

/**
 * Rate table shape used by measurement / TUI.
 * @param {string} id
 * @returns {{ inputPerMillion: number | null, outputPerMillion: number | null, cachedInputPerMillion: number | null, cacheWrite1hPerMillion?: number | null, cacheWrite5mPerMillion?: number | null, cacheReadPerMillion?: number | null, tier: string, source: string, label: string, estimated?: boolean } | null}
 */
export function demoModelRates(id, slotMapping = null) {
  if (isAnthropicSlotModel(id)) {
    // The incumbent side always runs the concrete canonical Anthropic id
    // (ANTHROPIC_SLOT_CONCRETE_IDS) via `claude -p --model`, which bypasses the
    // user's `ANTHROPIC_DEFAULT_*_MODEL` slot pin — so what runs is real
    // Anthropic regardless of the live mapping. Price it off the Anthropic list
    // table using that same concrete id, so the cost estimate matches reality.
    const concreteId = ANTHROPIC_SLOT_CONCRETE_IDS[id];
    const list = providerListPricing({ provider: "anthropic", modelId: concreteId });
    const slotLabel = demoModelLabel(id);
    return {
      inputPerMillion: list.inputPerMillion,
      outputPerMillion: list.outputPerMillion,
      cachedInputPerMillion: list.cachedInputPerMillion,
      // Anthropic prompt-cache rates (providerListPricing carries these via
      // toRateShape); included so result.json/compare.html show real write/read
      // rates, not $0, for the Anthropic incumbent.
      cacheWrite1hPerMillion: list.cacheWrite1hPerMillion ?? 0,
      cacheWrite5mPerMillion: list.cacheWrite5mPerMillion ?? 0,
      cacheReadPerMillion: list.cacheReadPerMillion ?? list.cachedInputPerMillion ?? 0,
      tier: list.tier,
      source: list.source,
      // "Claude Opus 5 (via Anthropic)" — parallel to the Fireworks branch's
      // "Claude Opus (via DeepSeek V4 Pro)". Using list.label would render the
      // slot name twice ("Claude Sonnet (Claude Sonnet)"), so use the slot label.
      label: `${slotLabel} (via Anthropic)`,
      ...(list.estimated ? { estimated: true } : {}),
    };
  }
  if (id === "firerouter" || isFirerouterModelPattern(id)) {
    return firerouterRates(id);
  }
  if (isAutoModelId(id)) {
    return autoMixRates(id);
  }
  const p = lookupFireworksPricing(id);
  if (!p) {
    return null;
  }
  return toDemoRateShape(p, {
    label: p.label,
    pricingRef: id,
  });
}

/** Whether a demo rate shape carries concrete input and output prices. */
export function hasDemoTokenRates(rates) {
  return Number.isFinite(rates?.inputPerMillion)
    && Number.isFinite(rates?.outputPerMillion);
}

export function defaultLeftModel() {
  return DEFAULT_LEFT_MODEL;
}

export function defaultRightModel() {
  return DEFAULT_RIGHT_MODEL;
}

/** Side display label: "Fireworks · GLM 5.2 Fast" or "Anthropic · Claude Opus". */
export function demoSideDisplayLabel(id) {
  if (isAnthropicSlotModel(id)) {
    return `Anthropic · ${demoModelLabel(id)}`;
  }
  if (isFirerouterModelPattern(id) || id === "firerouter") {
    return `Fireworks · ${demoModelLabel(id)}`;
  }
  return `Fireworks · ${demoModelLabel(id)}`;
}
