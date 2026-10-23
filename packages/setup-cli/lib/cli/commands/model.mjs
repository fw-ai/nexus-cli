import process from "node:process";

import { runModelListCommand } from "../../fireworks/model-list.mjs";
import { fireworksKeyPresent, resolveFireworksApiKeyValue } from "../../keys/api-key.mjs";
import { MISSING_FIREWORKS_API_KEY_MESSAGE } from "../../keys/key-type.mjs";

export async function runGlobalModelListCommand(ctx) {
  const keyArgs = {
    apiKey: ctx.apiKey,
    home: ctx.home || process.env.HOME || "",
  };
  if (!await fireworksKeyPresent(keyArgs)) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  // Read the key only if the catalog has to be fetched: a fresh cached
  // catalog lists without touching the keychain.
  await runModelListCommand({ options: ctx, apiKey: () => resolveFireworksApiKeyValue(keyArgs) });
}
