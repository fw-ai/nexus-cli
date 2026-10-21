/**
 * The models stock Codex lists in its picker, as Codex's own catalog rows.
 *
 * `codex debug models` prints the catalog Codex would load, in the same format
 * as `model_catalog_json`. Nexus's `model_catalog_json` replaces that
 * list and stops Codex refreshing it, so the command runs in a throwaway
 * CODEX_HOME whose `auth.json` is a symlink to the user's. Codex rewrites that
 * file in place, so a token refreshed during the run lands in the real file.
 * Signed in, Codex lists what the account can use; signed out, or with
 * keyring-stored auth (keyed by CODEX_HOME), it lists the models bundled with
 * that Codex release, and `--bundled` is the fallback when the refresh fails.
 * Visible rows are cached on disk so `--model` checks and catalog pruning
 * read them synchronously.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { scopedCacheFilePath } from "../../fireworks/serverless-catalog-cache.mjs";

const RUN_TIMEOUT_MS = 10_000;

/** @typedef {{ slug: string, display_name?: string, input_modalities?: string[], [field: string]: unknown }} CodexCatalogRow */

/** @type {CodexCatalogRow[] | null | undefined} undefined until first read */
let snapshot;

function cachePath() {
  return scopedCacheFilePath("codex-stock-models.json");
}

/**
 * The rows Codex's picker shows, in catalog order. Hidden rows are Codex
 * internals, not picker entries.
 * @param {unknown} doc a `codex debug models` document (or its `models` array)
 * @returns {CodexCatalogRow[]}
 */
export function parseCodexCatalogModels(doc) {
  const rows = Array.isArray(doc) ? doc : doc?.models;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.filter((row) => row && typeof row.slug === "string" && row.slug && row.visibility !== "hide");
}

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A leftover temp dir holds no credential: auth.json is only a symlink.
  }
}

/**
 * @param {string[]} args
 * @param {string} codexHome
 * @returns {Promise<CodexCatalogRow[]>} empty when Codex is missing, fails, or times out
 */
function runDebugModels(args, codexHome) {
  return new Promise((resolve) => {
    execFile(
      "codex",
      ["debug", "models", ...args],
      {
        env: { ...process.env, CODEX_HOME: codexHome },
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        cwd: codexHome,
      },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        try {
          resolve(parseCodexCatalogModels(JSON.parse(stdout)));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/**
 * Stock Codex's catalog for the user's sign-in, else the bundled one.
 * @param {string} codexHome the user's CODEX_HOME
 * @returns {Promise<CodexCatalogRow[]>}
 */
async function readStockCatalog(codexHome) {
  let probeHome;
  try {
    probeHome = mkdtempSync(path.join(os.tmpdir(), "fireconnect-codex-models-"));
    const auth = path.join(codexHome, "auth.json");
    if (existsSync(auth)) {
      symlinkSync(auth, path.join(probeHome, "auth.json"));
    }
    const signedIn = await runDebugModels([], probeHome);
    return signedIn.length ? signedIn : await runDebugModels(["--bundled"], probeHome);
  } catch {
    return [];
  } finally {
    if (probeHome) {
      removeDir(probeHome);
    }
  }
}

/**
 * Stock Codex's visible catalog rows from the last successful read, or null.
 * Synchronous: reads the disk cache once per process.
 * @returns {CodexCatalogRow[] | null}
 */
export function cachedCodexStockModels() {
  if (snapshot === undefined) {
    try {
      const rows = parseCodexCatalogModels(JSON.parse(readFileSync(cachePath(), "utf8")));
      snapshot = rows.length ? rows : null;
    } catch {
      snapshot = null;
    }
  }
  return snapshot;
}

/**
 * Re-read stock Codex's catalog and cache it. Best-effort and bounded: a
 * missing Codex, a failed run, or a timeout keeps the previous rows. Never
 * runs Codex under NEXUS_TEST; specs describe the catalog in
 * NEXUS_TEST_CODEX_MODELS (a `codex debug models` document) instead.
 * @param {{ codexHome: string }} opts
 * @returns {Promise<boolean>} true when fresh rows were cached
 */
export async function refreshCodexStockModels({ codexHome }) {
  let rows = [];
  try {
    rows = process.env.NEXUS_TEST === "1"
      ? parseCodexCatalogModels(JSON.parse(process.env.NEXUS_TEST_CODEX_MODELS || "null"))
      : await readStockCatalog(codexHome);
  } catch {
    return false;
  }
  if (!rows.length) {
    return false;
  }
  try {
    mkdirSync(path.dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), `${JSON.stringify({ cachedAt: Date.now(), models: rows })}\n`, { mode: 0o600 });
  } catch {
    // The in-memory rows still serve this process.
  }
  snapshot = rows;
  return true;
}

/** Set (or with null, clear) the in-memory rows without touching disk. Tests only. */
export function setCodexStockModelsForTests(rows) {
  snapshot = rows;
}
