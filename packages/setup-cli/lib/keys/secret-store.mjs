import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  builtinDeletePassword,
  builtinFileStoreAvailable,
  builtinGetPassword,
  builtinHasPassword,
  secretsFilePath,
  storeBuiltinFileSecretVerified,
} from "./builtin-file-secret-store.mjs";
import { ensureCliDependencies } from "../system/ensure-cli-deps.mjs";
import {
  deletePlaintextSecret,
  hasPlaintextSecret,
  plaintextSecretPath,
  plaintextSecretStoreAvailable,
  readPlaintextSecret,
} from "./plaintext-secret-store.mjs";
import {
  clearKeyStorageCache,
  readKeyStorageCache,
  readKeyStorageCacheEntry,
  writeKeyStorageCache,
} from "./storage-cache.mjs";
import {
  KEY_STORAGE_ENV,
  effectiveKeyStorageOverride,
  formatKeyStorageOverrideHint,
  readKeyStorageOverride,
} from "./storage-env.mjs";

export {
  KEY_STORAGE_ENV,
  LEGACY_KEY_STORAGE_ENV as SECRET_BACKEND_ENV,
} from "./storage-env.mjs";

import { writeFileAtomic } from "../io/atomic-write.mjs";
import { KeyringTimeoutError, withKeyringTimeout } from "./keyring-timeout.mjs";
import { shouldPreferFileBackendOnLinux } from "../config/secret-storage-policy.mjs";
import { fileBackendDetectionResult } from "./secret-backend-detect.mjs";
import { createSecretFallbackHandlers } from "./secret-fallbacks.mjs";

export const SECRET_SERVICE = "FireworksAI";
export const SECRET_ACCOUNT = "fireworks-api-key";

/**
 * Nexus-controlled storage override. Maps to cross-keychain's
 * `TS_KEYRING_BACKEND` (or an explicit native id) so the same backend is used
 * in this process and in any spawned `nexus key export` child.
 *   - `file`    → encrypted file backend (sandboxes / CI / no keychain)
 *   - `keychain`→ force the native OS keychain (error if none detected)
 *   - `null`    → explicit no-op backend (testing refusal paths)
 *   - unset     → auto: native keychain if available, else encrypted file, else error
 */

/** cross-keychain's own backend-selection env (upstream). */
const CROSS_KEYCHAIN_BACKEND_ENV = "TS_KEYRING_BACKEND";

/** Backend ids cross-keychain exposes. */
const NATIVE_BACKEND_IDS = ["native-macos", "macos", "native-windows", "windows", "native-linux", "secret-service"];
const FILE_BACKEND_ID = "file";
const NULL_BACKEND_ID = "null";

/**
 * In-process cache of secure-backend reads, so repeated getSecret/hasSecret
 * calls within a single command trigger at most ONE OS-keychain prompt. macOS
 * (and unsigned CLIs generally) prompt on every keychain item access, so a
 * command that resolves the key several times would otherwise prompt several
 * times. Keyed by resolved home + account. Populated on successful reads and on
 * writes; invalidated on delete and cleared in resetSecretStoreForTests.
 * @type {Map<string, string | null>}
 */
const secureReadCache = new Map();

function secureCacheKey(resolvedHome, account) {
  return `${resolvedHome}::${account}`;
}

/** @type {Map<string, string> | null} */
let memoryBackend = null;

/** @type {string | null} */
let memoryStoreHomeOverride = null;

/** Whether *we* set TS_KEYRING_BACKEND, so we can clean it up in tests. */
let weSetCrossKeychainBackendEnv = false;

/** The original TS_KEYRING_BACKEND value before we overrode it (for test reset). */
let originalCrossKeychainBackendEnv = undefined;

/** @type {Promise<typeof import("cross-keychain") | null> | null} */
let keychainModulePromise = null;

/** @type {typeof import("cross-keychain") | null} */
let keychainModule = null;

/**
 * Resolve the HOME to use for the memory store. Tests pass an explicit home
 * (the temp dir) so the memory file is written to the test sandbox, not the
 * real user home. Production calls omit the param and fall back to process.env.HOME.
 * @param {string} [home]
 * @returns {string}
 */
function resolveHome(home) {
  if (home) {
    return home;
  }
  return process.env.HOME?.trim() ?? "";
}

/**
 * True when an explicit `--home` (or caller home arg) differs from process HOME.
 * Secure backends otherwise read/write via process.env.HOME / XDG, which would
 * cross-contaminate sandboxed `--home` trees with the real user profile.
 * @param {string} resolvedHome
 */
function isHomeOverride(resolvedHome) {
  const resolved = resolvedHome?.trim() ?? "";
  if (!resolved) {
    return false;
  }
  return resolved !== (process.env.HOME?.trim() ?? "");
}

/**
 * Align HOME/XDG with a `--home` override for secure-backend ops only.
 * @template T
 * @param {string} resolvedHome
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withHomeScopedEnv(resolvedHome, fn) {
  if (!isHomeOverride(resolvedHome)) {
    return fn();
  }

  const resolved = resolvedHome.trim();
  const savedHome = process.env.HOME;
  const savedXdgData = process.env.XDG_DATA_HOME;
  const savedXdgConfig = process.env.XDG_CONFIG_HOME;

  process.env.HOME = resolved;
  process.env.XDG_DATA_HOME = path.join(resolved, ".local", "share");
  process.env.XDG_CONFIG_HOME = path.join(resolved, ".config");

  keychainModule = null;
  keychainModulePromise = null;
  try {
    keychainModule?.__resetKeyringStateForTests?.();
  } catch {
    // best effort
  }

  try {
    return await fn();
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedXdgData === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = savedXdgData;
    }
    if (savedXdgConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdgConfig;
    }
    keychainModule = null;
    keychainModulePromise = null;
    try {
      keychainModule?.__resetKeyringStateForTests?.();
    } catch {
      // best effort
    }
  }
}

/**
 * @param {string} resolvedHome
 * @returns {Promise<string | null>}
 */
async function readPlaintextSecretIfAvailable(resolvedHome) {
  if (!plaintextSecretStoreAvailable(resolvedHome)) {
    return null;
  }
  try {
    const plaintext = await readPlaintextSecret(resolvedHome);
    if (plaintext?.trim()) {
      lastReadError = null;
      return plaintext;
    }
  } catch (error) {
    lastReadError = /** @type {Error} */ (error);
  }
  return null;
}

function memoryStorePath(home, account = SECRET_ACCOUNT) {
  const suffix = account === SECRET_ACCOUNT ? "" : `-${account}`;
  return path.join(resolveHome(home), ".nexus", `.secret-memory${suffix}`);
}

async function loadMemoryStoreFromDisk(home, account = SECRET_ACCOUNT) {
  const filePath = memoryStorePath(home, account);
  if (!filePath) {
    return;
  }
  try {
    const value = (await readFile(filePath, "utf8")).trim();
    if (!memoryBackend) {
      useMemorySecretStore();
    }
    if (value) {
      memoryBackend.set(memoryKey(account), value);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function persistMemoryStoreToDisk(home, account = SECRET_ACCOUNT) {
  const filePath = memoryStorePath(home, account);
  if (!filePath || !memoryBackend) {
    return;
  }
  const value = memoryBackend.get(memoryKey(account)) ?? "";
  await mkdir(path.dirname(filePath), { recursive: true });
  if (value) {
    await writeFileAtomic(filePath, value, { mode: 0o600 });
  } else {
    try {
      await unlink(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function ensureMemoryStoreLoaded(home, account = SECRET_ACCOUNT) {
  if (useMemoryStore()) {
    const resolvedHome = resolveHome(home);
    if (!memoryBackend || memoryStoreHomeOverride !== resolvedHome) {
      memoryBackend = new Map();
      memoryStoreHomeOverride = resolvedHome;
    }
    await loadMemoryStoreFromDisk(home, account);
  }
}

/**
 * Use an in-memory secret store (tests).
 */
export function useMemorySecretStore() {
  memoryBackend = new Map();
  memoryStoreHomeOverride = null;
}

/**
 * Reset secret store backend selection (tests). Also resets cross-keychain's
 * internal backend cache so XDG/path changes between tests take effect.
 */
export function resetSecretStoreForTests() {
  memoryBackend = null;
  memoryStoreHomeOverride = null;
  keychainModule = null;
  keychainModulePromise = null;
  fallbackHandlers = null;
  secureReadCache.clear();
  void clearKeyStorageCache();
  if (weSetCrossKeychainBackendEnv) {
    // Restore the original (or delete if it was unset) so test isolation is clean.
    if (originalCrossKeychainBackendEnv === undefined) {
      delete process.env[CROSS_KEYCHAIN_BACKEND_ENV];
    } else {
      process.env[CROSS_KEYCHAIN_BACKEND_ENV] = originalCrossKeychainBackendEnv;
    }
    weSetCrossKeychainBackendEnv = false;
    originalCrossKeychainBackendEnv = undefined;
  }
  // Reset cross-keychain's module-level cache (always exported) so a changed
  // XDG_DATA_HOME / NEXUS_KEY_STORAGE is honored on the next op.
  try {
    if (keychainModule?.__resetKeyringStateForTests) {
      keychainModule.__resetKeyringStateForTests();
    }
  } catch {
    // ignore — best effort for test isolation
  }
}

function memoryKey(account = SECRET_ACCOUNT) {
  return `${SECRET_SERVICE}/${account}`;
}

async function memoryGet(account = SECRET_ACCOUNT) {
  return memoryBackend?.get(memoryKey(account)) ?? null;
}

async function memorySet(value, account = SECRET_ACCOUNT) {
  if (!memoryBackend) {
    throw new Error("Memory secret store is not active");
  }
  memoryBackend.set(memoryKey(account), value);
}

async function memoryDelete(account = SECRET_ACCOUNT) {
  memoryBackend?.delete(memoryKey(account));
}

async function memoryHas(account = SECRET_ACCOUNT) {
  return memoryBackend?.has(memoryKey(account)) ?? false;
}

/**
 * Lazily import cross-keychain once per process. On first failure, attempts
 * `npm install` in packages/setup-cli (repairs global/checkouts missing deps).
 * Returns null if the module still cannot be loaded so callers can fall back
 * to the built-in encrypted-file store.
 * @returns {Promise<typeof import("cross-keychain") | null>}
 */
async function loadKeychainModule() {
  if (keychainModule) {
    return keychainModule;
  }
  if (!keychainModulePromise) {
    keychainModulePromise = loadKeychainModuleAttempt();
  }
  return keychainModulePromise;
}

/**
 * @param {boolean} [retried]
 * @returns {Promise<typeof import("cross-keychain") | null>}
 */
async function loadKeychainModuleAttempt(retried = false) {
  try {
    const mod = await import("cross-keychain");
    keychainModule = mod;
    return mod;
  } catch {
    if (!retried && ensureCliDependencies()) {
      keychainModulePromise = null;
      return loadKeychainModuleAttempt(true);
    }
    keychainModule = null;
    return null;
  }
}

/**
 * Use the built-in encrypted-file store when cross-keychain is unavailable
 * but HOME/XDG paths are writable (same on-disk layout as cross-keychain file).
 * @returns {boolean}
 */
function useBuiltinFileFallback() {
  return !keychainModule && builtinFileStoreAvailable();
}

/**
 * @param {string} [home]
 * @returns {Promise<"keychain" | "file">}
 */
async function secureBackendKind(home) {
  const keychain = await loadKeychainModule();
  if (!keychain) {
    return "file";
  }
  const forced = effectiveKeyStorageOverride();
  if (forced === FILE_BACKEND_ID) {
    return "file";
  }
  if (forced === "keychain") {
    return "keychain";
  }
  // Same rule ensureBackendEnv applies: SSH/WSL writes go to the file backend.
  if (!forced && shouldPreferFileBackendOnLinux()) {
    return "file";
  }
  let backends = [];
  try {
    backends = await keychain.listBackends();
  } catch {
    backends = [];
  }
  return pickNativeBackendId(backends) ? "keychain" : "file";
}

/**
 * @param {string} value
 * @param {string} [home]
 */
async function storeSecretInSecureBackend(value, home, account = SECRET_ACCOUNT) {
  const trimmed = value?.trim() ?? "";
  const resolvedHome = resolveHome(home);
  await withHomeScopedEnv(resolvedHome, async () => {
    const keychain = await loadKeychainModule();
    if (!keychain) {
      if (useBuiltinFileFallback()) {
        await storeBuiltinFileSecretVerified(SECRET_SERVICE, account, trimmed);
        lastReadError = null;
        secureReadCache.set(secureCacheKey(resolvedHome, account), trimmed);
        return;
      }
      throw new Error(
        "Nexus's secret-storage module (cross-keychain) could not be loaded "
          + "and the encrypted-file fallback is unavailable (set HOME or XDG_DATA_HOME).",
      );
    }

    try {
      await ensureBackendEnv(keychain);
      await withKeyringTimeout(
        keychain.setPassword(SECRET_SERVICE, account, trimmed),
        "setPassword",
      );
    } catch (error) {
      throw friendlySecretError(error, home);
    }

    // The readback verifies backends that can accept a write yet store nothing
    // (a locked/null backend, or a read-only file). But a native OS keychain
    // that accepted setPassword without throwing is authoritative, and
    // re-reading the item triggers a SECOND OS prompt — so skip the readback
    // there and trust the successful write. File/null backends still verify
    // (their reads never prompt).
    if ((await secureBackendKind(home)) !== "keychain") {
      let readback = null;
      try {
        readback = await withKeyringTimeout(
          keychain.getPassword(SECRET_SERVICE, account),
          "getPassword",
        );
      } catch (error) {
        throw friendlySecretError(error, home);
      }
      if (!readback || readback.trim() !== trimmed) {
        const where = secretsFilePath() ?? "the keychain";
        throw new Error(
          `Storage verification failed: the key could not be read back from ${where}. `
            + "The keychain may be locked or the chosen backend is read-only.",
        );
      }
    }
    lastReadError = null;
    // Prime the read cache with the value we just wrote so any later
    // getSecret/hasSecret in this command needs no further keychain access.
    secureReadCache.set(secureCacheKey(resolvedHome, account), trimmed);
  });
}

/**
 * True once a store fell back to the encrypted file because the OS keychain
 * could not hold the key. That keychain is then left alone: asking it again
 * finds nothing (the key is in the file) until a reprobe moves it back.
 * @param {string} resolvedHome
 */
async function fileFallbackCommitted(resolvedHome) {
  return builtinFileStoreAvailable()
    && (await readKeyStorageCacheEntry(resolvedHome))?.storage === FILE_BACKEND_ID;
}

/**
 * @param {string} [home]
 * @returns {Promise<string | null>}
 */
async function readSecretFromSecureBackend(home, account = SECRET_ACCOUNT) {
  const resolvedHome = resolveHome(home);
  const cacheKey = secureCacheKey(resolvedHome, account);
  // Serve repeated reads in the same command from cache so we prompt the OS
  // keychain at most once per (home, account). Only successful reads are cached
  // (see below), so a transient read error never gets memoized as "no key".
  if (secureReadCache.has(cacheKey)) {
    lastReadError = null;
    return secureReadCache.get(cacheKey);
  }
  return withHomeScopedEnv(resolvedHome, async () => {
    const keychain = await fileFallbackCommitted(resolvedHome) ? null : await loadKeychainModule();
    if (!keychain) {
      if (builtinFileStoreAvailable()) {
        lastReadError = null;
        const value = await builtinGetPassword(SECRET_SERVICE, account);
        secureReadCache.set(cacheKey, value ?? null);
        return value;
      }
      lastReadError = new Error("cross-keychain module unavailable");
      return null;
    }

    try {
      await ensureBackendEnv(keychain);
      const value = await withKeyringTimeout(
        keychain.getPassword(SECRET_SERVICE, account),
        "getPassword",
      );
      lastReadError = null;
      secureReadCache.set(cacheKey, value ?? null);
      return value;
    } catch (error) {
      lastReadError = /** @type {Error} */ (error);
      return null;
    }
  });
}

/**
 * @param {string} [home]
 * @returns {Promise<boolean>}
 */
async function hasSecretInSecureBackend(home, account = SECRET_ACCOUNT) {
  const value = await readSecretFromSecureBackend(home, account);
  return Boolean(value?.trim());
}

/**
 * @param {string} [home]
 */
async function deleteSecretFromSecureBackend(home, account = SECRET_ACCOUNT) {
  const resolvedHome = resolveHome(home);
  secureReadCache.delete(secureCacheKey(resolvedHome, account));
  await withHomeScopedEnv(resolvedHome, async () => {
    const keychain = await fileFallbackCommitted(resolvedHome) ? null : await loadKeychainModule();
    if (!keychain) {
      if (builtinFileStoreAvailable()) {
        try {
          await builtinDeletePassword(SECRET_SERVICE, account);
        } catch {
          // Missing entry is fine.
        }
      }
      return;
    }

    try {
      await ensureBackendEnv(keychain);
      await withKeyringTimeout(
        keychain.deletePassword(SECRET_SERVICE, account),
        "deletePassword",
      );
    } catch {
      // Missing entry is fine.
    }
  });
}

/**
 * Write the storage cache, clearing a corrupt or stale entry on failure.
 *
 * @param {string} home
 * @param {"keychain" | "file" | "plaintext"} storage
 * @param {string} [reason]
 * @param {{ required?: boolean }} [options]
 */
async function persistKeyStorageCache(home, storage, reason = "", options = {}) {
  const { required = false } = options;
  try {
    await writeKeyStorageCache(home, storage, reason);
    return;
  } catch {
    await clearKeyStorageCache(home);
    try {
      await writeKeyStorageCache(home, storage, reason);
      return;
    } catch (error) {
      await clearKeyStorageCache(home);
      if (required) {
        throw error;
      }
    }
  }
}

/**
 * After a successful secure-backend write, align cache and plaintext without
 * undoing the secure store. Cleanup is best-effort and must not throw.
 *
 * @param {string} resolvedHome
 * @param {string} [home]
 */
async function finalizeSecureSecretWrite(resolvedHome, home) {
  const kind = await secureBackendKind(home);
  try {
    await persistKeyStorageCache(resolvedHome, kind);
  } catch {
    await clearKeyStorageCache(resolvedHome);
  }
  try {
    await deletePlaintextSecret(resolvedHome);
  } catch {
    // Secure storage + cache are authoritative once the cache is updated.
  }
}

/** @type {ReturnType<typeof createSecretFallbackHandlers> | null} */
let fallbackHandlers = null;

function getFallbackHandlers() {
  if (!fallbackHandlers) {
    fallbackHandlers = createSecretFallbackHandlers({
      resolveHome,
      withHomeScopedEnv,
      persistKeyStorageCache,
      clearKeyStorageCache,
      deleteSecretFromSecureBackend,
      primeSecureReadCache: (resolvedHome, account, value) => {
        secureReadCache.set(secureCacheKey(resolvedHome, account), value);
      },
      clearLastReadError: () => {
        lastReadError = null;
      },
      secretService: SECRET_SERVICE,
      secretAccount: SECRET_ACCOUNT,
    });
  }
  return fallbackHandlers;
}

function isTestSecretStoreContext() {
  return process.env.NEXUS_TEST === "1";
}

function useMemoryStore() {
  if (memoryBackend !== null) {
    return true;
  }
  return process.env.NEXUS_SECRET_STORE === "memory" && isTestSecretStoreContext();
}

/**
 * The last error observed by a read-side op (getSecret/hasSecret), so
 * `detectSecretBackend` can distinguish "no key stored" from "backend broken".
 * @type {Error | null}
 */
let lastReadError = null;

/**
 * @returns {Error | null}
 */
export function getLastSecretReadError() {
  return lastReadError;
}

/**
 * Resolve the data root cross-keychain's file backend writes to, mirroring its
 * XDG/HOME resolution. Returns "" when HOME is unavailable on a non-Windows OS.
 * @returns {string}
 */
function keychainFileDataRoot() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "keyring");
  }
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA || process.env.ProgramData || process.env.HOME || "";
    return root ? path.join(root, "Keyring") : "";
  }
  const home = process.env.HOME?.trim() ?? "";
  return home ? path.join(home, ".local", "share", "keyring") : "";
}

/**
 * Friendly label for a native backend id.
 * @param {string} id
 * @returns {string}
 */
function nativeBackendLabel(id) {
  if (id === "native-macos" || id === "macos") return "macOS Keychain";
  if (id === "native-windows" || id === "windows") return "Windows Credential Manager";
  if (id === "native-linux" || id === "secret-service") return "Secret Service (libsecret)";
  return "OS keychain";
}

/**
 * Pick the highest-priority native backend id from a list of supported backends.
 * @param {{ id: string, priority?: number }[]} backends
 * @returns {string | null}
 */
function pickNativeBackendId(backends) {
  const native = backends.filter((b) => NATIVE_BACKEND_IDS.includes(b.id));
  if (!native.length) {
    return null;
  }
  native.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return native[0].id;
}

/**
 * Apply Nexus's backend override to cross-keychain by setting the
 * upstream `TS_KEYCHAIN_BACKEND` env before cross-keychain initializes its
 * active backend. The Nexus override ALWAYS wins over a pre-existing
 * `TS_KEYRING_BACKEND` (the user set NEXUS_KEY_STORAGE explicitly).
 * Throws (friendly) for `keychain`
 * when no native backend is detected.
 * @param {typeof import("cross-keychain")} keychain
 */
async function ensureBackendEnv(keychain) {
  const forced = effectiveKeyStorageOverride();
  if (!forced && shouldPreferFileBackendOnLinux()) {
    applyCrossKeychainBackend(FILE_BACKEND_ID);
    return;
  }
  if (!forced) {
    return;
  }
  if (forced === FILE_BACKEND_ID) {
    applyCrossKeychainBackend(FILE_BACKEND_ID);
    return;
  }
  if (forced === NULL_BACKEND_ID) {
    applyCrossKeychainBackend(NULL_BACKEND_ID);
    return;
  }
  if (forced === "keychain") {
    let backends = [];
    try {
      backends = await keychain.listBackends();
    } catch {
      backends = [];
    }
    const nativeId = pickNativeBackendId(backends);
    if (!nativeId) {
      throw new Error(
        `${formatKeyStorageOverrideHint("keychain")} but no OS keychain was detected on this system. `
          + "Unset it to allow the encrypted-file fallback, or install a keychain (gnome-keyring + secret-service on Linux).",
      );
    }
    applyCrossKeychainBackend(nativeId);
    return;
  }
  // Unknown value: ignore silently rather than break storage.
}

/**
 * Set cross-keychain's backend-selection env, capturing the original value once
 * so {@link resetSecretStoreForTests} can restore it. The Nexus override
 * always wins over a pre-existing `TS_KEYRING_BACKEND`.
 * @param {string} id
 */
function applyCrossKeychainBackend(id) {
  if (!weSetCrossKeychainBackendEnv) {
    originalCrossKeychainBackendEnv = process.env[CROSS_KEYCHAIN_BACKEND_ENV];
  }
  process.env[CROSS_KEYCHAIN_BACKEND_ENV] = id;
  weSetCrossKeychainBackendEnv = true;
}

/**
 * Translate a cross-keychain / filesystem error into a friendly, actionable message.
 * @param {unknown} error
 * @param {string} home
 * @returns {Error}
 */
function friendlySecretError(error, home) {
  const err = /** @type {Error & { code?: string, name?: string } } */ (error);
  const name = err?.name ?? "";
  const code = err?.code ?? "";
  const dataRoot = keychainFileDataRoot();

  if (name === "KeyringLockedError") {
    return new Error(
      "The OS keychain is locked. Unlock it (e.g. sign in to your desktop session / unlock the keyring) and re-run `nexus configure`.",
    );
  }
  if (name === "NoKeyringError" || name === "InitError") {
    return new Error(
      "No OS keychain is available and the encrypted-file fallback could not be initialized. "
        + "Set HOME and ensure ~/.local/share is writable (or set XDG_DATA_HOME), or install a keychain (gnome-keyring + secret-service on Linux).",
    );
  }
  if (name === "PasswordSetError") {
    return new Error(
      "Could not write the API key to the secret store (the keychain rejected the write). "
        + "Check keychain permissions and re-run `nexus configure`.",
    );
  }
  if (code === "EACCES" || code === "EROFS") {
    const where = dataRoot || "~/.local/share/keyring";
    return new Error(
      `Could not write the secret store: ${code} on ${where}. `
        + `Make the directory writable (or set XDG_DATA_HOME / ${formatKeyStorageOverrideHint("file")} to a writable location).`,
    );
  }
  if (code === "ENOSPC") {
    return new Error("Could not write the secret store: the disk is full (ENOSPC).");
  }
  if (code === "ENOENT" || code === "ENAMETOOLONG") {
    return new Error(
      `Could not initialize the secret store (${code}). HOME=${home || "(unset)"}. `
        + "Set HOME to a writable directory and re-run `nexus configure`.",
    );
  }
  if (err instanceof KeyringTimeoutError || name === "KeyringTimeoutError") {
    return new Error(
      "The OS keychain did not respond in time (common on SSH without an unlocked keyring). "
        + `Use ${formatKeyStorageOverrideHint("file")} or export FIREWORKS_API_KEY for this session.`,
    );
  }
  const detail = err?.message ? ` ${err.message}` : "";
  return new Error(`Could not store the API key in the secret store.${detail}`);
}

/**
 * Detect the active secret backend for reporting (no writes, no key material).
 * Mirrors cross-keychain's selection: Nexus override → native keychain →
 * encrypted file → unavailable.
 *
 * `home` is only used for the in-memory test store's path; the file/keychain
 * backend location comes from cross-keychain (XDG_DATA_HOME / os.homedir()).
 *
 * @param {string} [home]
 * @returns {Promise<{
 *   backend: "keychain" | "file" | "memory" | "plaintext" | "unavailable",
 *   label: string,
 *   location?: string,
 *   forced?: boolean,
 *   error?: string,
 * }>}
 */
export async function detectSecretBackend(home = process.env.HOME ?? "") {
  if (useMemoryStore()) {
    return {
      backend: "memory",
      label: "In-memory test store",
      location: memoryStorePath(home),
    };
  }

  const cached = await readKeyStorageCache(home);
  if (
    cached === "plaintext"
    && plaintextSecretStoreAvailable(home)
    && await hasPlaintextSecret(home)
  ) {
    return {
      backend: "plaintext",
      label: "Plaintext file (0600, last-resort fallback)",
      location: plaintextSecretPath(home) ?? undefined,
      error: "Secure storage failed earlier; using ~/.nexus/.api-key. Run `nexus update` to move the key to the OS keychain.",
    };
  }

  const keychain = await loadKeychainModule();
  if (!keychain) {
    if (builtinFileStoreAvailable()) {
      return fileBackendDetectionResult(secretsFilePath(), {
        error: "The cross-keychain secret module could not be loaded; using the built-in encrypted-file fallback. Reinstall Nexus (`nexus update`) to restore full keychain support.",
      });
    }
    return {
      backend: "unavailable",
      label: "Unavailable",
      error: "The cross-keychain secret module could not be loaded. Reinstall Nexus (`nexus update`).",
    };
  }

  const forced = effectiveKeyStorageOverride();
  const explicit = readKeyStorageOverride();
  if (!forced && cached === FILE_BACKEND_ID && builtinFileStoreAvailable()) {
    return fileBackendDetectionResult(secretsFilePath(), {
      error: "The OS keychain could not store the key, so Nexus uses the encrypted file. Run `nexus update` once the keychain works to move the key there.",
    });
  }
  // Prefer cross-keychain's own data root so the reported location matches
  // where its file backend actually writes (it uses os.homedir()/XDG, which can
  // differ from the process.env.HOME fallback in keychainFileDataRoot).
  let dataRoot = "";
  try {
    dataRoot = typeof keychain.dataRoot === "function" ? keychain.dataRoot() : "";
  } catch {
    dataRoot = "";
  }
  if (!dataRoot) {
    dataRoot = keychainFileDataRoot();
  }
  const fileLocation = dataRoot ? path.join(dataRoot, "secrets.json") : null;

  if (forced === FILE_BACKEND_ID) {
    return fileBackendDetectionResult(fileLocation, {
      forced: explicit === FILE_BACKEND_ID,
      unavailableError: `${formatKeyStorageOverrideHint("file")} but HOME is not set and XDG_DATA_HOME is unset. Set HOME or XDG_DATA_HOME to a writable path.`,
    });
  }
  if (forced === NULL_BACKEND_ID) {
    return {
      backend: "unavailable",
      label: "Disabled (null backend)",
      forced: true,
      error: `${formatKeyStorageOverrideHint("null")} disables secret storage. Unset it to store a key.`,
    };
  }

  let backends = [];
  try {
    backends = await keychain.listBackends();
  } catch {
    backends = [];
  }
  const nativeId = pickNativeBackendId(backends);
  const hasFile = backends.some((b) => b.id === FILE_BACKEND_ID);

  if (forced === "keychain") {
    if (!nativeId) {
      return {
        backend: "unavailable",
        label: "Unavailable",
        forced: true,
        error: `${formatKeyStorageOverrideHint("keychain")} but no OS keychain was detected. Unset it to allow the encrypted-file fallback.`,
      };
    }
    return {
      backend: "keychain",
      label: nativeBackendLabel(nativeId),
      forced: true,
    };
  }

  // auto — SSH/WSL remote Linux uses encrypted file instead of libsecret.
  if (shouldPreferFileBackendOnLinux()) {
    return fileBackendDetectionResult(fileLocation);
  }
  if (nativeId) {
    return {
      backend: "keychain",
      label: nativeBackendLabel(nativeId),
    };
  }
  if (hasFile) {
    return fileBackendDetectionResult(fileLocation);
  }
  if (plaintextSecretStoreAvailable(home) && await hasPlaintextSecret(home)) {
    return {
      backend: "plaintext",
      label: "Plaintext file (0600, last-resort fallback)",
      location: plaintextSecretPath(home) ?? undefined,
      error: "Secure storage is unavailable; reading from ~/.nexus/.api-key.",
    };
  }
  return {
    backend: "unavailable",
    label: "Unavailable",
    error: "No secret storage backend is available. Set HOME / XDG_DATA_HOME to a writable path, or install a keychain (gnome-keyring + secret-service on Linux).",
  };
}

/**
 * @param {string} [home]
 * @returns {Promise<string | null>}
 */
export async function getSecret(home) {
  if (useMemoryStore()) {
    await ensureMemoryStoreLoaded(home);
    return memoryGet();
  }

  const resolvedHome = resolveHome(home);
  const homeOverride = isHomeOverride(resolvedHome);
  const cacheEntry = await readKeyStorageCacheEntry(resolvedHome);
  if (cacheEntry?.storage === "plaintext") {
    try {
      const plaintext = await readPlaintextSecret(resolvedHome);
      if (plaintext?.trim()) {
        lastReadError = null;
        return plaintext;
      }
    } catch (error) {
      lastReadError = /** @type {Error} */ (error);
    }
    await clearKeyStorageCache(resolvedHome);
    if (cacheEntry.reason) {
      return null;
    }
  }

  if (homeOverride) {
    const plaintext = await readPlaintextSecretIfAvailable(resolvedHome);
    if (plaintext) {
      return plaintext;
    }
  }

  const secure = await readSecretFromSecureBackend(home);
  if (secure?.trim()) {
    lastReadError = null;
    return secure;
  }

  if (!homeOverride) {
    const plaintext = await readPlaintextSecretIfAvailable(resolvedHome);
    if (plaintext) {
      return plaintext;
    }
  }

  return null;
}

/**
 * Store a secret. Readback-verifies the write so a locked/null backend that
 * accepts the write but returns nothing is surfaced as an error, not a silent
 * empty key.
 *
 * @param {string} value
 * @param {string} [home]
 */
export async function setSecret(value, home) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error("API key is required");
  }

  if (useMemoryStore()) {
    await ensureMemoryStoreLoaded(home);
    await memorySet(trimmed);
    await persistMemoryStoreToDisk(home);
    return;
  }

  const resolvedHome = resolveHome(home);
  const outcome = await getFallbackHandlers().storeSecretWithFallbacks(
    trimmed,
    home,
    storeSecretInSecureBackend,
  );
  if (outcome === "secure") {
    await finalizeSecureSecretWrite(resolvedHome, home);
  }
}

/**
 * @param {string} [home]
 * @returns {Promise<boolean>}
 */
export async function hasSecret(home) {
  if (useMemoryStore()) {
    await ensureMemoryStoreLoaded(home);
    return memoryHas();
  }

  const resolvedHome = resolveHome(home);
  const homeOverride = isHomeOverride(resolvedHome);
  const cacheEntry = await readKeyStorageCacheEntry(resolvedHome);
  if (cacheEntry?.storage === "plaintext") {
    try {
      if (await hasPlaintextSecret(resolvedHome)) {
        lastReadError = null;
        return true;
      }
    } catch (error) {
      lastReadError = /** @type {Error} */ (error);
    }
    await clearKeyStorageCache(resolvedHome);
    if (cacheEntry.reason) {
      return false;
    }
  }

  if (homeOverride && plaintextSecretStoreAvailable(resolvedHome)) {
    try {
      if (await hasPlaintextSecret(resolvedHome)) {
        lastReadError = null;
        return true;
      }
    } catch (error) {
      lastReadError = /** @type {Error} */ (error);
    }
  }

  if (await hasSecretInSecureBackend(home)) {
    return true;
  }

  if (!homeOverride && plaintextSecretStoreAvailable(resolvedHome)) {
    try {
      return await hasPlaintextSecret(resolvedHome);
    } catch (error) {
      lastReadError = /** @type {Error} */ (error);
    }
  }

  return false;
}

/**
 * @param {string} [home]
 */
export async function deleteSecret(home) {
  if (useMemoryStore()) {
    await ensureMemoryStoreLoaded(home);
    if (memoryBackend) {
      await memoryDelete();
    }
    await persistMemoryStoreToDisk(home);
    return;
  }

  const resolvedHome = resolveHome(home);
  await deleteSecretFromSecureBackend(home);
  await deletePlaintextSecret(resolvedHome);
  await clearKeyStorageCache(resolvedHome);
}

/**
 * Delete the encrypted-file copy of a key that reprobe just stored in the
 * keychain, but only once the key reads back without it. If it doesn't (the
 * write landed in that same file, or the keychain dropped it), restore the
 * copy and record the file again: the key is never left without a copy.
 * @param {string} resolvedHome
 * @param {string} key
 * @returns {Promise<boolean>} true when the copy was removed
 */
async function retireFileFallbackCopy(resolvedHome, key) {
  await withHomeScopedEnv(resolvedHome, () => builtinDeletePassword(SECRET_SERVICE, SECRET_ACCOUNT)).catch(() => {});
  secureReadCache.clear();
  if ((await readSecretFromSecureBackend(resolvedHome))?.trim() === key) {
    return true;
  }
  await withHomeScopedEnv(resolvedHome, () => storeBuiltinFileSecretVerified(SECRET_SERVICE, SECRET_ACCOUNT, key));
  await persistKeyStorageCache(resolvedHome, FILE_BACKEND_ID, "The OS keychain did not keep the key.", { required: true });
  secureReadCache.clear();
  return false;
}

/**
 * Clear the cached storage choice and try secure storage again. Used by
 * `nexus update` and `NEXUS_REPROBE_KEY_STORAGE=1`. When a key sits in the
 * plaintext or encrypted-file fallback, attempts to move it back to the
 * keychain (or, from plaintext, to the encrypted file).
 *
 * @param {string} [home]
 * @returns {Promise<{ migrated: boolean, movedFrom?: "plaintext" | "file" | null, backend: Awaited<ReturnType<typeof detectSecretBackend>> }>}
 */
export async function reprobeKeyStorage(home = process.env.HOME ?? "") {
  const resolvedHome = resolveHome(home);
  if (!resolvedHome) {
    return {
      migrated: false,
      backend: {
        backend: "unavailable",
        label: "Unavailable",
        error: "HOME is not set.",
      },
    };
  }

  const plaintextKey = (await readPlaintextSecret(resolvedHome))?.trim() ?? "";
  const fileFallbackKey = await fileFallbackCommitted(resolvedHome)
    ? (await readSecretFromSecureBackend(resolvedHome))?.trim() ?? ""
    : "";
  await clearKeyStorageCache(resolvedHome);
  // Reprobe re-selects the backend and may migrate the key; drop cached reads so
  // the fresh backend choice isn't shadowed by a stale in-process value.
  secureReadCache.clear();
  keychainModule = null;
  keychainModulePromise = null;

  const carriedKey = plaintextKey || fileFallbackKey;
  if (carriedKey) {
    const outcome = await getFallbackHandlers().storeSecretWithFallbacks(
      carriedKey,
      resolvedHome,
      storeSecretInSecureBackend,
      { quiet: !plaintextKey },
    );
    let movedFrom = plaintextKey && outcome !== "plaintext" ? "plaintext" : null;
    if (outcome === "secure") {
      await finalizeSecureSecretWrite(resolvedHome, resolvedHome);
      if (fileFallbackKey && (await readKeyStorageCache(resolvedHome)) !== FILE_BACKEND_ID
          && await retireFileFallbackCopy(resolvedHome, fileFallbackKey)) {
        movedFrom ??= "file";
      }
    }
    return {
      migrated: Boolean(movedFrom),
      movedFrom,
      backend: await detectSecretBackend(resolvedHome),
    };
  }

  const backend = await detectSecretBackend(resolvedHome);
  if (backend.backend === "keychain" || backend.backend === "file") {
    await writeKeyStorageCache(resolvedHome, backend.backend);
  }
  return { migrated: false, backend };
}
