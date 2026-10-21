/** Force key storage mode: `file`, `keychain`, or `null`. */
export const KEY_STORAGE_ENV = "NEXUS_KEY_STORAGE";

/** @deprecated Renamed to {@link KEY_STORAGE_ENV}. Still read for compatibility. */
export const LEGACY_KEY_STORAGE_ENV = "FIRECONNECT_SECRET_BACKEND";

/**
 * @returns {string}
 */
export function readKeyStorageOverride() {
  return process.env[KEY_STORAGE_ENV]?.trim()
    || process.env[LEGACY_KEY_STORAGE_ENV]?.trim()
    || "";
}

/** Effective override; tests default to file storage instead of the OS keychain. */
export function effectiveKeyStorageOverride() {
  return readKeyStorageOverride()
    || (process.env.NEXUS_TEST === "1" ? "file" : "");
}

/**
 * @returns {boolean}
 */
export function isKeyStorageForcedNull() {
  return readKeyStorageOverride() === "null";
}

/**
 * @param {string} value
 * @returns {string}
 */
export function formatKeyStorageOverrideHint(value) {
  return `NEXUS_KEY_STORAGE=${value}`;
}
