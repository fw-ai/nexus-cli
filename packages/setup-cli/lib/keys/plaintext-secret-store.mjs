import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const PLAINTEXT_RELATIVE_PATH = ".nexus/.api-key";

/**
 * @param {string} home
 * @returns {string | null}
 */
export function plaintextSecretPath(home) {
  const resolved = home?.trim() ?? "";
  return resolved ? path.join(resolved, PLAINTEXT_RELATIVE_PATH) : null;
}

/**
 * @param {string} home
 * @returns {boolean}
 */
export function plaintextSecretStoreAvailable(home) {
  return Boolean(plaintextSecretPath(home));
}

/**
 * @param {string} home
 * @returns {Promise<string | null>}
 */
export async function readPlaintextSecret(home) {
  const filePath = plaintextSecretPath(home);
  if (!filePath) {
    return null;
  }
  try {
    return (await readFile(filePath, "utf8")).trim() || null;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {string} home
 * @param {string} value
 */
export async function writePlaintextSecret(home, value) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error("API key is required");
  }
  const filePath = plaintextSecretPath(home);
  if (!filePath) {
    throw new Error("HOME is not set; cannot use the plaintext secret fallback");
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${trimmed}\n`, { mode: 0o600 });
}

/**
 * @param {string} home
 */
export async function deletePlaintextSecret(home) {
  const filePath = plaintextSecretPath(home);
  if (!filePath) {
    return;
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function hasPlaintextSecret(home) {
  const value = await readPlaintextSecret(home);
  return Boolean(value?.trim());
}
