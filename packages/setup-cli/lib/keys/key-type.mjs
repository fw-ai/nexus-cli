export const MISSING_FIREWORKS_API_KEY_MESSAGE =
  "No Fireworks API key found. No settings were changed.\n\n"
  + "Sign in:\n"
  + "  nexus login\n\n"
  + "Custom SSO:\n"
  + "  nexus login --account <account-id>";

export const FIREPASS_KEY_UNSUPPORTED_MESSAGE =
  "Fire Pass keys (fpk_...) are no longer supported. Run `nexus login` to sign in.";

/** Fire Pass keys were retired; callers use this only to explain the rejection. */
export function isFirePassKey(key) {
  return typeof key === "string" && key.trim().startsWith("fpk_");
}

export function isFireworksShapedKey(key) {
  return typeof key === "string" && key.startsWith("fw_");
}

export const isFireworksKey = isFireworksShapedKey;

export function fireworksKeyOrEmpty(key) {
  return isFireworksShapedKey(key) ? key.trim() : "";
}
