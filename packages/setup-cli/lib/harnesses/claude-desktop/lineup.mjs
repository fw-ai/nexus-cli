/**
 * Pure picker-lineup logic shared by the profile lane (writes the profile)
 * and the shim (answers /v1/models and maps request model names). Leaf
 * module: no config, keys, or harness imports — the KeepAlive shim must not
 * pull the CLI's full module graph (a missing runtime package would
 * crash-loop the launchd agent instead of self-healing).
 */
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { AUTO_MODEL_ID, canonicalAutoModelId, AUTO_INSTANT_MODEL_ID } from "../../fireworks/model-specs.mjs";
import { autoCatalogEntryId } from "../../fireworks/models.mjs";

/**
 * Claude Desktop's per-deployment data directory (Electron `userData`):
 * - macOS: ~/Library/Application Support/<name>
 * - Linux: $XDG_CONFIG_HOME/<name>, else ~/.config/<name>
 * The app derives the 3p directory as the first-party one plus "-3p", so
 * both deployments share one layout. XDG_CONFIG_HOME is honored only for the
 * real home: `--home <dir>` redirects everything under that dir (tests,
 * sandboxes), and an inherited XDG value would escape it.
 * Other platforms keep the macOS layout; `on` refuses them before any write.
 */
export function desktopDataDir(home, name, {
  platform = process.platform, env = process.env, realHome = os.homedir(),
} = {}) {
  if (platform === "linux") {
    const xdg = env.XDG_CONFIG_HOME;
    const base = xdg && path.isAbsolute(xdg) && path.resolve(home) === path.resolve(realHome)
      ? xdg : path.join(home, ".config");
    return path.join(base, name);
  }
  return path.join(home, "Library", "Application Support", name);
}

/** The first-party (claude.ai) deployment's data directory. */
export function firstPartyDir(home, options) {
  return desktopDataDir(home, "Claude", options);
}

/** The 3p deployment's data directory. */
export function thirdPartyDir(home, options) {
  return desktopDataDir(home, "Claude-3p", options);
}

export const DEFAULT_MODEL_MAP = {
  models: {
    "claude-opus-4-8": AUTO_MODEL_ID,
    "claude-sonnet-4-8": "glm-latest",
    "claude-haiku-4-5": "glm-flash-latest",
  },
  families: { opus: AUTO_MODEL_ID, fable: AUTO_MODEL_ID, sonnet: "glm-latest", haiku: "glm-flash-latest" },
  labels: { [AUTO_MODEL_ID]: "Auto (Fireworks)", "kimi-latest": "Kimi K3 (Fireworks)", "glm-latest": "GLM 5.3 (Fireworks)", "glm-flash-latest": "GLM 5.3 Flash (Fireworks)" },
};

/**
 * Static picker list: bare catalog ids (validate + get catalog descriptions),
 * Fireworks labelOverride, no [1m]/supports1m — any variant spelling renders
 * a second "1M context window" row, and the distinction is cosmetic anyway:
 * the shim strips [1m] and the Fireworks model serves its full native window
 * on every request.
 */
export const PICKER_MODELS = [
  // Names must be catalog-present ids (the Effort submenu and descriptions
  // render only for models with thinking options in the signed catalog).
  { name: "claude-opus-4-8", labelOverride: "Auto (Fireworks)", anthropicFamilyTier: "opus", isFamilyDefault: true, route: AUTO_MODEL_ID },
  { name: "claude-sonnet-5-5", labelOverride: "GLM 5.3 (Fireworks)", anthropicFamilyTier: "sonnet", isFamilyDefault: true, route: "glm-latest" },
  { name: "claude-haiku-4-5-20251001", labelOverride: "GLM 5.3 Flash (Fireworks)", anthropicFamilyTier: "haiku", isFamilyDefault: true, route: "glm-flash-latest" },
];

/**
 * Build the full picker line-up: the auto mixes plus one entry per -latest
 * Fireworks router, each named with a UNIQUE signed-catalog id (tier-matched
 * where the pool allows; leftovers borrow unused ids of any tier). `auto`
 * ranks first so it takes the first opus id as that tier's default. Also
 * returns the shim model map covering every entry (bare only — the [1m]
 * spelling renders a duplicate row in static lists).
 */
/**
 * Build the full picker line-up: auto routers first, then one entry per
 * `-latest` Fireworks router. Names are synthetic family-shaped ids
 * (claude-<tier>-<route>): the app requires claude-* names and a family tier,
 * but these match NO signed-catalog id, so the picker renders OUR labels (the
 * serverless display names — what the CLI's model list shows) and NO borrowed
 * catalog blurbs. Returns the model map the shim uses to route each id.
 */

export function serverlessLineup(entries, catalog) {
  const routers = (entries ?? []).filter((e) => typeof e?.shortId === "string"
    && canonicalAutoModelId(e.shortId) !== AUTO_INSTANT_MODEL_ID
    && (/-latest$/.test(e.shortId) || autoCatalogEntryId(e)));
  const rows = (catalog?.surfaces?.chat?.model_selector_config ?? [])
    .flatMap((c) => c?.models ?? [])
    .filter((m) => typeof m?.id === "string");
  if (!routers.length || !rows.length) return null;

  const tierOf = (router) => {
    if (autoCatalogEntryId(router)) return "opus";
    const lower = `${router.displayName ?? router.shortId}`.toLowerCase();
    if (/kimi|opus|fable|max/.test(lower)) return "opus";
    if (/flash|mini|haiku/.test(lower)) return "haiku";
    return "sonnet";
  };
  const tierPriority = { opus: 0, sonnet: 1, haiku: 2 };
  const rank = (router) => {
    const autoId = autoCatalogEntryId(router);
    if (autoId) return autoId === AUTO_MODEL_ID ? -2 : -1;
    return tierPriority[tierOf(router)];
  };
  const byTier = { opus: [], sonnet: [] };
  for (const row of rows) {
    if (/haiku/.test(row.id.toLowerCase())) continue;
    const tier = /opus|fable/.test(row.id.toLowerCase()) ? "opus" : "sonnet";
    byTier[tier].push(row);
  }
  const usedIds = new Set();
  const usedLabels = new Set();
  const models = [];
  const modelMapEntries = [];
  const sorted = [...routers].sort((a, b) => rank(a) - rank(b));
  for (const router of sorted) {
    const tier = tierOf(router);
    let pool = (byTier[tier] ?? []).filter((r) => !usedIds.has(r.id));
    if (!pool.length) pool = byTier.opus.concat(byTier.sonnet).filter((r) => !usedIds.has(r.id));
    const row = pool[0];
    if (!row) break;
    const label = router.displayName ?? router.shortId;
    if (usedLabels.has(label)) continue;
    usedIds.add(row.id);
    usedLabels.add(label);
    models.push({
      name: row.id,
      labelOverride: label,
      anthropicFamilyTier: tier,
      isFamilyDefault: !models.some((m) => m.anthropicFamilyTier === tier),
      route: router.shortId,
    });
    modelMapEntries.push([row.id, router.shortId]);
  }
  return {
    models,
    modelMap: {
      models: Object.fromEntries(modelMapEntries),
      families: { ...DEFAULT_MODEL_MAP.families },
      labels: { ...DEFAULT_MODEL_MAP.labels },
    },
  };
}

