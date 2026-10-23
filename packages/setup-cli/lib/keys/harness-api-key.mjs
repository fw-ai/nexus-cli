import process from "node:process";

import {
  FIREWORKS_API_KEY_ENV_REF,
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  writeGlobalConfig,
} from "../config/global-config.mjs";
import {
  fireworksKeyPresent,
  persistApiKeyFromFlag,
  resolveFireworksApiKeyValue,
  tryReadKeychainSecret,
} from "./api-key.mjs";
import {
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "./key-type.mjs";

function effectiveHarnessStoredKey(stored, harnessEnvRef) {
  if (!stored?.trim()) {
    return "";
  }
  const trimmed = stored.trim();
  if (
    trimmed === harnessEnvRef
    || trimmed.startsWith("{env:")
    || trimmed === "${FIREWORKS_API_KEY}"
  ) {
    return process.env.FIREWORKS_API_KEY?.trim() ?? "";
  }
  return isFireworksShapedKey(trimmed) ? trimmed : "";
}

/**
 * Resolve credentials for `<harness> on`: migrate reusable harness-local
 * literals into key storage and return the resolved key to bake as a literal.
 */
export async function resolveHarnessOnApiKey({
  apiKey = "",
  home = process.env.HOME ?? "",
  harnessEnvRef,
  getExistingHarnessKey,
  promptForKey = async () => "",
}) {
  if (apiKey?.trim() && home) {
    await persistApiKeyFromFlag(home, apiKey.trim());
  }

  let effectiveKey = await resolveFireworksApiKeyValue({ apiKey, home });
  let source = "env";

  if (!effectiveKey && getExistingHarnessKey) {
    const harnessKey = effectiveHarnessStoredKey(
      await getExistingHarnessKey(),
      harnessEnvRef,
    );
    if (harnessKey) {
      effectiveKey = harnessKey;
      source = "harness-local-literal";
      if (home) {
        await persistApiKeyFromFlag(home, harnessKey);
      }
    }
  }

  if (!effectiveKey && home) {
    const fromKeychain = await tryReadKeychainSecret(home);
    if (fromKeychain) {
      effectiveKey = fromKeychain;
      source = "keychain-fallback";
      await writeGlobalConfig(home, {
        apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
      });
    }
  }

  if (!effectiveKey && home) {
    effectiveKey = await promptForKey(home);
    if (effectiveKey) {
      source = "prompt";
    }
  }

  if (!effectiveKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const existingHarnessKey = getExistingHarnessKey
    ? await getExistingHarnessKey()
    : "";
  const reusedExistingKey = Boolean(
    existingHarnessKey
    && (existingHarnessKey === harnessEnvRef
      || existingHarnessKey === effectiveKey),
  );

  if (apiKey?.trim()) {
    source = "flag";
  } else if (source !== "harness-local-literal" && source !== "prompt" && home) {
    const storedKey = (await readGlobalConfig(home)).apiKey;
    if (storedKey === FIREWORKS_API_KEY_KEYCHAIN_REF) {
      source = "global-keychain";
    } else if (storedKey === FIREWORKS_API_KEY_ENV_REF) {
      source = "global-env-ref";
    } else if (storedKey) {
      source = "global-legacy-literal";
    }
  }

  // Bake the resolved key as a plaintext literal in harness configs so tools
  // work without a shell hook or FIREWORKS_API_KEY in the environment.
  return {
    apiKey: effectiveKey,
    apiKeyFromFlag: Boolean(apiKey?.trim()),
    reusedExistingKey,
    source,
    effectiveKey,
  };
}

export async function resolveFireworksApiKey({
  apiKey = "",
  resolveKey,
  home = process.env.HOME ?? "",
}) {
  const fromStored = await resolveFireworksApiKeyValue({ apiKey, home });
  if (fromStored) {
    return fromStored;
  }

  const harnessKey = resolveKey ? await resolveKey() : "";
  return isFireworksShapedKey(harnessKey) ? harnessKey.trim() : "";
}

/**
 * Whether `harnessFullKey` would find a key, without reading the stored one
 * (see `fireworksKeyPresent`). For status output that only reports presence.
 * @param {import("../harness/types.mjs").HarnessContext} ctx
 * @param {(ctx: import("../harness/types.mjs").HarnessContext) => Promise<string>} resolveKey
 */
export async function harnessHasFullKey(ctx, resolveKey) {
  if (await fireworksKeyPresent({ apiKey: ctx.apiKey, home: ctx.home })) {
    return true;
  }
  return isFireworksShapedKey(await resolveKey(ctx));
}

export function harnessFullKey(ctx, resolveKey) {
  return resolveFireworksApiKey({
    apiKey: ctx.apiKey,
    resolveKey: () => resolveKey(ctx),
    home: ctx.home,
  });
}
