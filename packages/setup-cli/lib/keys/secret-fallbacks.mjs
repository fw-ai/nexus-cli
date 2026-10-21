import { accent, warn as uiWarn } from "../ui.mjs";
import {
  builtinFileStoreAvailable,
  secretsFilePath,
  storeBuiltinFileSecretVerified,
} from "./builtin-file-secret-store.mjs";
import {
  deletePlaintextSecret,
  plaintextSecretPath,
  plaintextSecretStoreAvailable,
  readPlaintextSecret,
  writePlaintextSecret,
} from "./plaintext-secret-store.mjs";
import { isKeyStorageForcedNull } from "./storage-env.mjs";

/**
 * @typedef {object} SecretFallbackDeps
 * @property {(home?: string) => string} resolveHome
 * @property {(resolvedHome: string, fn: () => Promise<void>) => Promise<void>} withHomeScopedEnv
 * @property {(home: string, storage: "keychain" | "file" | "plaintext", reason?: string, options?: { required?: boolean }) => Promise<void>} persistKeyStorageCache
 * @property {(home: string) => Promise<void>} clearKeyStorageCache
 * @property {(home?: string) => Promise<void>} deleteSecretFromSecureBackend
 * @property {(resolvedHome: string, account: string, value: string) => void} primeSecureReadCache
 * @property {() => void} clearLastReadError
 * @property {string} secretService
 * @property {string} secretAccount
 */

/**
 * @param {SecretFallbackDeps} deps
 */
export function createSecretFallbackHandlers(deps) {
  /**
   * @param {string} value
   * @param {string} home
   * @param {unknown} cause
   * @param {string} [account]
   * @param {{ quiet?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async function storeSecretInFileFallback(value, home, cause, account = deps.secretAccount, { quiet = false } = {}) {
    const trimmed = value?.trim() ?? "";
    const resolvedHome = deps.resolveHome(home);
    if (!builtinFileStoreAvailable()) {
      return false;
    }

    try {
      await deps.withHomeScopedEnv(resolvedHome, async () => {
        await storeBuiltinFileSecretVerified(deps.secretService, account, trimmed);
      });
    } catch {
      return false;
    }

    const reason = cause instanceof Error ? cause.message : String(cause);
    try {
      await deps.persistKeyStorageCache(resolvedHome, "file", reason, { required: true });
    } catch (error) {
      await deps.clearKeyStorageCache(resolvedHome);
      throw error;
    }
    deps.clearLastReadError();
    deps.primeSecureReadCache(resolvedHome, account, trimmed);

    const location = secretsFilePath() ?? "~/.local/share/keyring/secrets.json";
    if (!quiet) {
      console.warn(uiWarn(
        `OS keychain storage was unavailable (${reason}); stored the Fireworks API key `
          + `in an encrypted file at ${location} (AES-256-GCM, 0600). Run ${accent("nexus update")} once an OS `
          + "keychain is available to move it back to secure storage.",
      ));
    }
    try {
      await deletePlaintextSecret(resolvedHome);
    } catch {
      // Secure file storage + cache are authoritative.
    }
    return true;
  }

  /**
   * @param {string} value
   * @param {string} home
   * @param {unknown} cause
   */
  async function storeSecretInPlaintextFallback(value, home, cause) {
    const trimmed = value?.trim() ?? "";
    const previousPlaintext = await readPlaintextSecret(home);
    await writePlaintextSecret(home, trimmed);
    const readback = (await readPlaintextSecret(home))?.trim() ?? "";
    if (readback !== trimmed) {
      throw new Error(
        "Storage verification failed: the key could not be read back from the plaintext fallback file.",
      );
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    try {
      await deps.persistKeyStorageCache(home, "plaintext", reason, { required: true });
    } catch (error) {
      try {
        if (previousPlaintext?.trim()) {
          await writePlaintextSecret(home, previousPlaintext);
        } else {
          await deletePlaintextSecret(home);
        }
      } catch {
        // Rollback is best-effort; surface the cache persist failure.
      }
      throw error;
    }
    try {
      await deps.deleteSecretFromSecureBackend(home);
    } catch {
      // Best-effort; getSecret/hasSecret ignore lingering secure copies once
      // plaintext fallback has committed (cache carries the fallback reason).
    }
    deps.clearLastReadError();
    const location = plaintextSecretPath(home) ?? "~/.nexus/.api-key";
    console.warn(uiWarn(
      `secure storage was unavailable (${reason}); stored the Fireworks API key `
        + `in a plaintext file at ${location} (0600). Run ${accent("nexus update")} once an OS `
        + "keychain is available to move it back to secure storage.",
    ));
  }

  /**
   * secure → encrypted file → plaintext ladder shared by setSecret and reprobe.
   *
   * @param {string} value
   * @param {string} [home]
   * @param {(value: string, home?: string) => Promise<void>} storeSecure
   * @param {{ quiet?: boolean }} [options] quiet: the key is already in the
   *   encrypted file, so landing there again is not news
   * @returns {Promise<"secure" | "file" | "plaintext">}
   */
  async function storeSecretWithFallbacks(value, home, storeSecure, { quiet = false } = {}) {
    const trimmed = value?.trim() ?? "";
    const resolvedHome = deps.resolveHome(home);
    try {
      await storeSecure(trimmed, home);
      return "secure";
    } catch (error) {
      if (isKeyStorageForcedNull()) {
        throw error;
      }
      if (await storeSecretInFileFallback(trimmed, resolvedHome, error, deps.secretAccount, { quiet })) {
        return "file";
      }
      if (!plaintextSecretStoreAvailable(resolvedHome)) {
        throw error;
      }
      await storeSecretInPlaintextFallback(trimmed, resolvedHome, error);
      return "plaintext";
    }
  }

  return {
    storeSecretInFileFallback,
    storeSecretInPlaintextFallback,
    storeSecretWithFallbacks,
  };
}
