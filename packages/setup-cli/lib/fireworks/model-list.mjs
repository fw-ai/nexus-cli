import { resolveModelDisplayMetadata } from "./model-display.mjs";
import { visionCapabilityLabel } from "./vision.mjs";
import { attachPricing, formatUsd } from "./pricing.mjs";
import {
  allModelsByRecency,
  autoCatalogEntry,
  autoCatalogEntryId,
  filterCatalogBySearch,
  isAutoCatalogEntry,
  loadServerlessCatalog,
  preferLatestAliases,
} from "./models.mjs";
import { stripViaFireworksSuffix } from "./label-suffix.mjs";
import { refreshListPriceCache } from "../pricing/list-price-cache.mjs";
import { KNOWN_AUTO_MODEL_IDS, isRetiredModelId } from "./model-id.mjs";
import { autoTagline, firerouterTagline } from "../firerouter/core.mjs";
import { bold, dim, warn, withSpinner } from "../ui.mjs";

export function formatCatalogUpdatedAt(updatedAt, timeZone = undefined) {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return "bundled with Nexus CLI";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(updatedAt));
}

function catalogUpdatedAtIso(updatedAt) {
  return Number.isFinite(updatedAt) && updatedAt > 0
    ? new Date(updatedAt).toISOString()
    : null;
}

function printCatalogFooter(displayCount, updatedAt) {
  const count = displayCount == null
    ? ""
    : `${displayCount} model${displayCount === 1 ? "" : "s"} · `;
  console.log(dim(`${count}Last updated: ${formatCatalogUpdatedAt(updatedAt)}`));
  console.log(dim("Refresh catalog: nexus model list --refresh"));
}

function displayName(entry) {
  const name = stripViaFireworksSuffix(entry.displayName);
  const visionLabel = visionCapabilityLabel(entry.id);
  return visionLabel === "text-only" ? `${name} (text-only)` : name;
}

function isFastLatestRouter(entry) {
  // For now, the FAST section surfaces only the `-fast-latest` router aliases
  // (glm-fast-latest, kimi-fast-latest, …) — the versioned `-fast`/`-turbo`
  // models (kimi-k3-fast, glm-5p2-fast, …) collapse into those aliases via
  // preferLatestAliases and shouldn't be listed separately here.
  return entry.shortId?.endsWith("-fast-latest");
}

function isUsRouter(entry) {
  return entry.shortId?.endsWith("-us");
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => left.shortId.localeCompare(right.shortId));
}

export function organizeCatalogForDisplay(catalog) {
  // `auto` sorts ahead of `firerouter`, so the smart-routing section leads with
  // the default recommendation.
  const smartRouters = catalog.filter((entry) => (
    entry.shortId === "firerouter" || isAutoCatalogEntry(entry)
  ));
  // Collapse versioned families via their -latest router aliases across the
  // whole catalog, then split. Running preferLatestAliases over the full set is
  // what keeps standalone models that have no -latest alias (gpt-oss-120b,
  // inkling, nemotron-3-ultra-nvfp4) visible instead of dropping them.
  const nonSmart = catalog.filter((entry) => (
    entry.shortId !== "firerouter"
    && !isAutoCatalogEntry(entry)
  ));
  const preferred = preferLatestAliases(nonSmart);
  const routers = preferred.filter((entry) => entry.id.includes("/routers/"));
  const usRouters = routers.filter(isUsRouter);
  const fastRouters = routers.filter(isFastLatestRouter);
  const latestRouters = routers.filter((entry) => (
    !isFastLatestRouter(entry)
    && entry.shortId.endsWith("-latest")
  ));
  // Every versioned model the catalog serves, newest first — no family
  // collapsing, so older versions stay visible for pinning.
  const models = allModelsByRecency(nonSmart);

  return [
    {
      title: "SMART ROUTERS",
      description: "one model picked per user turn",
      entries: sortEntries(smartRouters),
    },
    {
      title: "LATEST ROUTERS",
      description: "recommended, automatically track new versions",
      entries: sortEntries(latestRouters),
    },
    {
      title: "FAST ROUTERS",
      description: "higher tokens per second",
      entries: sortEntries(fastRouters),
    },
    {
      title: "US-ONLY ROUTERS",
      description: "inference stays in the US",
      entries: sortEntries(usRouters),
    },
    {
      title: "INDIVIDUAL MODELS",
      description: "all versions, newest first",
      entries: models,
    },
  ].filter((section) => section.entries.length > 0);
}

function tableWidths(catalog) {
  return {
    id: Math.max(8, ...catalog.map((entry) => entry.shortId.length)),
    name: Math.max(12, ...catalog.map((entry) => displayName(entry).length)),
    input: Math.max(5, ...catalog.map((entry) => formatUsd(entry.pricing?.inputPerMillion).length)),
    cached: Math.max(6, ...catalog.map((entry) => formatUsd(entry.pricing?.cachedInputPerMillion).length)),
    output: Math.max(6, ...catalog.map((entry) => formatUsd(entry.pricing?.outputPerMillion).length)),
  };
}

function formatTable(catalog, widths, showPricing) {
  const header = bold(
    `${"ID".padEnd(widths.id)}  `
    + `${"NAME".padEnd(widths.name)}  `
    + (showPricing
      ? `${"INPUT".padStart(widths.input)}  `
        + `${"CACHED".padStart(widths.cached)}  `
        + `${"OUTPUT".padStart(widths.output)}`
      : ""),
  );
  const lines = catalog.map((entry) => {
    const base = `${bold(entry.shortId.padEnd(widths.id))}  `
      + `${displayName(entry).padEnd(widths.name)}`;
    if (!showPricing) {
      return base;
    }
    const input = formatUsd(entry.pricing?.inputPerMillion).padStart(widths.input);
    const cached = formatUsd(entry.pricing?.cachedInputPerMillion).padStart(widths.cached);
    const output = formatUsd(entry.pricing?.outputPerMillion).padStart(widths.output);
    return `${base}  ${dim(input)}  ${dim(cached)}  ${dim(output)}`;
  });
  return [header, ...lines].join("\n");
}

/** One-liner per smart router, shown under the SMART ROUTERS table. */
export const SMART_ROUTER_NOTES = {
  auto: autoTagline("auto"),
  "auto-instant": autoTagline("auto-instant"),
  firerouter: firerouterTagline("firerouter"),
};

export function formatCatalogSections(sections) {
  const catalog = sections.flatMap((section) => section.entries);
  const widths = tableWidths(catalog);
  const showPricing = catalog.some((entry) => entry.pricing);
  const lines = [
    bold("Nexus CLI coding models"),
    ...(showPricing ? [dim("Prices in USD per 1M tokens.")] : []),
  ];

  for (const section of sections) {
    const heading = section.description
      ? `${section.title}: ${section.description}`
      : section.title;
    lines.push("", bold(heading), formatTable(section.entries, widths, showPricing));
    if (section.title === "SMART ROUTERS") {
      const noted = section.entries.filter((entry) => SMART_ROUTER_NOTES[entry.shortId]);
      const labelWidth = Math.max(0, ...noted.map((entry) => entry.shortId.length + 1));
      for (const entry of noted) {
        lines.push(dim(`  ${`${entry.shortId}:`.padEnd(labelWidth)}  ${SMART_ROUTER_NOTES[entry.shortId]}`));
      }
    }
  }
  return lines.join("\n");
}

function enrichCatalogWithPricing(catalog) {
  return catalog.map((entry) => {
    const pricing = attachPricing(entry.id);
    return {
      ...entry,
      ...resolveModelDisplayMetadata(entry.id),
      pricing,
      pricingDisplay: pricing?.display ?? "—",
    };
  });
}

/**
 * Add the synthesized auto-mix rows for display. The gateway serves them
 * without listing them, so `model list` is the only place they can come from.
 *
 * Rows come from KNOWN_AUTO_MODEL_IDS, not from the `auto-*` matcher that
 * governs acceptance: a name can only be advertised once Nexus knows it
 * exists, while `--model` stays free to pass a newer mix straight through.
 * @param {import("./models.mjs").CatalogEntry[]} catalog
 */
export function catalogWithAutoEntry(catalog) {
  // Retired routes/mixes never display, even in a hand-built catalog.
  const supported = catalog.filter((entry) => (
    !isRetiredModelId(entry?.shortId ?? "")
    && !isRetiredModelId(entry?.id ?? "")
  ));
  const present = new Set(supported.map(autoCatalogEntryId).filter(Boolean));
  const missing = KNOWN_AUTO_MODEL_IDS
    .filter((id) => !present.has(id))
    .map((id) => autoCatalogEntry(id));
  return missing.length ? [...missing, ...supported] : supported;
}

export async function runModelListCommand({ options, apiKey }) {
  const refresh = Boolean(options.refresh);
  // List prices refresh on the same cadence as the catalog read below: stale
  // caches warm in the background of every `model list`, `--refresh` forces.
  await refreshListPriceCache({ force: refresh });
  const { catalog, source, updatedAt } = await withSpinner(
    refresh ? "Refreshing Fireworks model catalog…" : "Fetching Fireworks model catalog…",
    () => loadServerlessCatalog({ apiKey, refresh }),
  );

  // Retired routes (FireRouter, `auto-instant`) are never listed, whether
  // the gateway still returns the row or Nexus would have synthesized one.
  const fullCatalog = catalogWithAutoEntry(
    catalog.filter((entry) => (
      !isRetiredModelId(entry?.shortId ?? "")
      && !isRetiredModelId(entry?.id ?? "")
    )),
  );

  const enriched = enrichCatalogWithPricing(fullCatalog);

  if (options.json) {
    const filtered = filterCatalogBySearch(enriched, options.search);
    console.log(JSON.stringify({
      source,
      updatedAt: catalogUpdatedAtIso(updatedAt),
      count: filtered.length,
      models: filtered,
    }, null, 2));
    return;
  }

  // A refresh that couldn't reach the gateway falls back to the last snapshot,
  // so say so rather than presenting cached rows as freshly fetched.
  if (refresh && source === "stale") {
    console.log(warn("Couldn't reach Fireworks — showing the last cached catalog."));
    console.log("");
  }

  const sections = organizeCatalogForDisplay(enriched)
    .map((section) => ({
      ...section,
      entries: filterCatalogBySearch(section.entries, options.search),
    }))
    .filter((section) => section.entries.length > 0);
  const displayCount = sections.reduce((total, section) => total + section.entries.length, 0);

  if (displayCount === 0) {
    console.log("No serverless models matched your query.");
    console.log("");
    printCatalogFooter(null, updatedAt);
    return;
  }

  console.log(formatCatalogSections(sections));
  console.log("");
  printCatalogFooter(displayCount, updatedAt);
}
