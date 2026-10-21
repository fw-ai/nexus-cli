/**
 * Once-per-model price healing for the Claude status line.
 *
 * A model added mid-session (e.g. via `/model` picking a freshly launched
 * serverless row) can appear in the transcript before any price cache knows
 * its rate, degrading the whole line to `cost n/a`. The helper therefore
 * heals before first paint: it records the unpriced models in a per-session
 * marker (each model gets one attempt per session), spawns a minimal
 * detached runner that warms the caches through the shared loaders, and polls
 * for the missing rates within a tight bound — so the line prints dollars
 * when the refresh is quick and never stalls when it is not.
 *
 * Two load-bearing constraints shape this module:
 * - The helper process must exit promptly in every case (Claude Code waits
 *   for the command to exit before painting), so the refresh runs detached
 *   and the parent only polls. Past the bound the runner keeps healing
 *   unfollowed and the next turn is priced.
 * - This module statically imports node builtins only. Key resolution and
 *   catalog fetching pull the harness dependency graph, so they resolve
 *   lazily via dynamic import inside {@link refreshPriceCaches} — which only
 *   ever executes in the runner or in specs, never on the per-turn path.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { reloadServerlessCatalogSnapshot } from "../../fireworks/serverless-catalog-cache.mjs";
import { reloadListPriceRates } from "../../pricing/list-price-cache.mjs";

const RUNNER_ENTRY = fileURLToPath(new URL("../../../bin/claude-price-refresh.mjs", import.meta.url));
const MARKER_DIRNAME = "statusline-refresh";
// Stale markers are pruned opportunistically so ~/.nexus cannot fill
// with one file per session over time.
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Upper bound the pre-print poll waits: slow networks fall back to the cached
// line while the detached runner heals the next turn. Once per session.
export const STATUSLINE_HEAL_TIMEOUT_MS = 3000;
const STATUSLINE_HEAL_POLL_MS = 100;

/** Session id from a transcript path: basename without `.jsonl`, else "". */
export function sessionIdFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
    return "";
  }
  const base = path.basename(transcriptPath.trim());
  return base.toLowerCase().endsWith(".jsonl") && base.length > 6
    ? base.slice(0, -".jsonl".length)
    : "";
}

/** True when any model in the parsed usage has no rate (renders `n/a`). */
export function hasUnpricedModels(usage) {
  return Array.isArray(usage?.models)
    && usage.models.some((model) => model == null || model.cost == null);
}

function markerDir(home) {
  return path.join(home, ".nexus", MARKER_DIRNAME);
}

function markerFor(home, sessionId) {
  return path.join(markerDir(home), `${sessionId}.refreshed`);
}

function pruneMarkers(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > MARKER_TTL_MS) {
        rmSync(file, { force: true });
      }
    } catch {
      // Best-effort: a leftover marker only costs a stat per turn.
    }
  }
}

function unpricedModelKeys(usage) {
  return [...new Set(
    usage.models
      .filter((model) => model == null || model.cost == null)
      .map((model) => String(model?.id ?? model?.label ?? "")),
  )];
}

/**
 * Models this session already attempted. Markers that predate per-model
 * tracking hold a bare timestamp and read as "none attempted", which grants
 * those sessions one more refresh.
 */
function readAttemptedModels(marker) {
  let raw;
  try {
    raw = readFileSync(marker, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.models) ? parsed.models.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Claim a healing attempt for this session's unpriced models. Each model gets
 * one attempt per session, so an unpriceable model cannot use up the attempt a
 * later `/model` switch needs. Synchronous and side-effect free beyond the
 * marker file, so the render path can call it unconditionally.
 *
 * @param {{ home?: string, transcriptPath?: string, usage?: object | null }} [options]
 * @returns {boolean} True when the caller should kick off a refresh.
 */
export function claimSessionPriceHealing({ home = "", transcriptPath = "", usage = null } = {}) {
  try {
    if (process.env.NEXUS_TEST === "1" || process.env.NEXUS_STATUSLINE_REFRESH === "0") {
      return false;
    }
    if (!hasUnpricedModels(usage)) {
      return false;
    }
    const sessionId = sessionIdFromTranscript(transcriptPath);
    if (!home || !sessionId) {
      return false;
    }
    const dir = markerDir(home);
    mkdirSync(dir, { recursive: true });
    const marker = markerFor(home, sessionId);
    const attempted = readAttemptedModels(marker) ?? [];
    const fresh = unpricedModelKeys(usage).filter((key) => !attempted.includes(key));
    if (fresh.length === 0) {
      return false;
    }
    // Claim before spawning so concurrent turns cannot double up.
    writeFileSync(marker, JSON.stringify({ at: Date.now(), models: [...attempted, ...fresh] }));
    pruneMarkers(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh both price caches through the shared loaders (serverless catalog
 * and models.dev list prices, concurrently). Never throws and never touches
 * harness configs. Heavy modules resolve lazily so the per-turn helper's
 * static graph stays at node builtins — this only executes in the detached
 * runner or in specs.
 */
export async function refreshPriceCaches({ home = "", env = process.env } = {}) {
  try {
    const [
      { loadServerlessCatalog },
      { resolveFireworksApiKey },
      { claudeFireworksKeyFrom },
      { refreshListPriceCache },
    ] = await Promise.all([
      import("../../fireworks/models.mjs"),
      import("../../keys/harness-api-key.mjs"),
      import("./core.mjs"),
      import("../../pricing/list-price-cache.mjs"),
    ]);
    await Promise.all([
      (async () => {
        // Claude Code hands the status line its settings env, which carries
        // the key `nexus claude on` baked into the gateway header. That is
        // the only key in reach when it was resolved from a shell's
        // FIREWORKS_API_KEY at `on` time and never persisted.
        const apiKey = await resolveFireworksApiKey({
          home,
          resolveKey: () => claudeFireworksKeyFrom({ env }),
        });
        if (apiKey) {
          await loadServerlessCatalog({ apiKey, refresh: true });
        }
      })(),
      refreshListPriceCache({ force: true }),
    ]);
  } catch {
    // Best-effort: keyless, offline, or broken-dependency machines keep
    // serving from cache.
  }
}

/**
 * Spawn the detached refresh runner. Returns the child (or null when spawning
 * is impossible), unref'd so the helper exits on its own schedule. Call only
 * after {@link claimSessionPriceHealing} returns true: a spawn that dies
 * asynchronously releases the marker, so the next turn retries instead of
 * burning the session's single attempt on a stillborn refresh.
 *
 * @param {{ home?: string, sessionId?: string, spawnFn?: typeof spawn }} [options]
 */
export function spawnPriceRefresh({ home = "", sessionId = "", spawnFn = spawn } = {}) {
  if (!home || !sessionId) {
    return null;
  }
  const marker = markerFor(home, sessionId);
  let child = null;
  try {
    child = spawnFn(process.execPath, [RUNNER_ENTRY], {
      detached: true,
      stdio: "ignore",
      // Windows gives a detached child its own console; without this the
      // first heal in a session flashes a window over Claude Code.
      windowsHide: true,
      env: process.env,
    });
  } catch {
    child = null;
  }
  if (!child) {
    try {
      rmSync(marker, { force: true });
    } catch {}
    return null;
  }
  child.unref?.();
  child.on?.("error", () => {
    try {
      rmSync(marker, { force: true });
    } catch {}
  });
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-read both price caches from disk. Pricing lookups memoize the snapshot
 * in memory, so without this a polling process re-prices from stale rows
 * forever even after the background runner warms the files. Total.
 */
function reloadPriceCachesFromDisk() {
  reloadServerlessCatalogSnapshot();
  reloadListPriceRates();
}

/**
 * Re-read usage until every model is priced, the runner exits, or the bound
 * elapses — whichever comes first. Each tick reloads the caches from disk
 * first, so rows the detached runner wrote become visible. Pure polling over
 * injected functions, so the render never waits on the network itself.
 *
 * @param {{ readUsage?: () => Promise<object | null>, reloadCaches?: () => void, child?: { exitCode?: number | null } | null, timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitForPricedUsage({
  readUsage = async () => null,
  reloadCaches = reloadPriceCachesFromDisk,
  child = null,
  timeoutMs = STATUSLINE_HEAL_TIMEOUT_MS,
  intervalMs = STATUSLINE_HEAL_POLL_MS,
} = {}) {
  const started = Date.now();
  let usage = null;
  let exited = false;
  for (;;) {
    reloadCaches();
    try {
      usage = await readUsage();
    } catch {
      // Keep the last usage: a failed re-read must never blank the line.
    }
    // Null is "no reading", never "priced": only a real usage object with
    // rates on every model satisfies the poll.
    if (usage != null && !hasUnpricedModels(usage)) {
      return usage;
    }
    // The runner writes caches synchronously before it exits, so the first
    // tick that observes the exit gets one grace re-read: without it the poll
    // can return a stale snapshot written milliseconds earlier.
    if (child == null || child.exitCode !== null) {
      if (!exited) {
        exited = true;
        continue;
      }
      return usage;
    }
    if (Date.now() - started >= timeoutMs) {
      return usage;
    }
    await sleep(intervalMs);
  }
}
