import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

/** @typedef {"keychain" | "file" | "plaintext"} CachedKeyStorage */

const CACHE_RELATIVE_PATH = ".nexus/key-storage.json";
const LEGACY_CACHE_RELATIVE_PATH = ".nexus/secret-backend.json";

/** When set, ignore ~/.nexus/key-storage.json and re-probe secure storage. */
export const REPROBE_KEY_STORAGE_ENV = "NEXUS_REPROBE_KEY_STORAGE";
const LEGACY_REPROBE_KEY_STORAGE_ENV = "FIRECONNECT_REPROBE_SECRET_BACKEND";

/**
 * @typedef {{ storage: CachedKeyStorage, reason: string }} KeyStorageCacheEntry
 */

/** @type {Map<string, KeyStorageCacheEntry>} */
const processCache = new Map();

/**
 * @param {string} home
 * @returns {string}
 */
function cachePath(home) {
  return path.join(home, CACHE_RELATIVE_PATH);
}

/**
 * @param {string} home
 * @returns {string}
 */
function legacyCachePath(home) {
  return path.join(home, LEGACY_CACHE_RELATIVE_PATH);
}

/**
 * @returns {boolean}
 */
export function reprobeKeyStorageEnvSet() {
  return Boolean(
    process.env[REPROBE_KEY_STORAGE_ENV]?.trim()
    || process.env[LEGACY_REPROBE_KEY_STORAGE_ENV]?.trim(),
  );
}

/**
 * @param {string} home
 * @returns {Promise<string | null>}
 */
async function readCacheFileContents(home) {
  try {
    return await readFile(cachePath(home), "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    return await readFile(legacyCachePath(home), "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {string} home
 * @returns {Promise<KeyStorageCacheEntry | null>}
 */
export async function readKeyStorageCacheEntry(home) {
  if (!home) {
    return null;
  }
  if (reprobeKeyStorageEnvSet()) {
    return null;
  }
  if (processCache.has(home)) {
    return processCache.get(home) ?? null;
  }
  const raw = await readCacheFileContents(home);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const storage = parsed?.storage ?? parsed?.backend;
    if (storage === "keychain" || storage === "file" || storage === "plaintext") {
      const entry = {
        storage,
        reason: typeof parsed?.reason === "string" ? parsed.reason.trim() : "",
      };
      processCache.set(home, entry);
      return entry;
    }
  } catch {
    // ignore corrupt cache
  }
  return null;
}

/**
 * @param {string} home
 * @returns {Promise<CachedKeyStorage | null>}
 */
export async function readKeyStorageCache(home) {
  const entry = await readKeyStorageCacheEntry(home);
  return entry?.storage ?? null;
}

/**
 * @param {string} home
 * @param {CachedKeyStorage} storage
 * @param {string} [reason]
 */
export async function writeKeyStorageCache(home, storage, reason = "") {
  if (!home) {
    return;
  }
  processCache.set(home, { storage, reason: reason.trim() });
  await mkdir(path.dirname(cachePath(home)), { recursive: true, mode: 0o700 });
  await writeFile(
    cachePath(home),
    `${JSON.stringify({
      storage,
      reason: reason || undefined,
      updatedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  try {
    await unlink(legacyCachePath(home));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * @param {string} [home]
 */
export async function clearKeyStorageCache(home) {
  if (home) {
    processCache.delete(home);
    for (const filePath of [cachePath(home), legacyCachePath(home)]) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return;
  }
  processCache.clear();
}
