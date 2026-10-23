import process from "node:process";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  MISSING_AZURE_BASE_URL_MESSAGE,
  assertAzureApiKey,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../config/global-config.mjs";
import {
  AUTO_PROVIDER_KEYS,
  printAutoProviderKeyReach,
  promptForProviderKey,
  saveAutoProviderKeys,
  unsetAutoProviderKeys,
} from "../../keys/auto-provider-keys.mjs";
import { accent } from "../../ui/term.mjs";
import { warn } from "../../ui/index.mjs";
import { printNote, printSuccess } from "../messages.mjs";

/**
 * `nexus configure` sets the provider (Fireworks vs a Microsoft Azure AI
 * Foundry endpoint). Its `--anthropic-api-key` / `--openai-api-key` /
 * `--unset` still work but are deprecated: provider keys for Nexus Auto
 * belong to `nexus auto`.
 *
 * It does NOT set the Fireworks API key (use `nexus login`) and does NOT
 * register harnesses (enable one with `nexus <harness>`). In this
 * command `--api-key` is the *Azure* endpoint key and is only accepted with
 * `--provider azure`.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runConfigureCommand(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }

  const provider = ctx.provider?.trim() ?? "";
  if (provider && provider !== "azure" && provider !== "fireworks") {
    throw new Error("--provider must be one of: fireworks, azure");
  }

  // `--api-key` here is the Azure endpoint key, not the Fireworks key.
  if (ctx.apiKeyFromFlag && provider !== "azure") {
    throw new Error(
      "configure doesn't set the Fireworks API key — run `nexus login` "
        + "(or `nexus login --with-token` for CI). In configure, --api-key is the "
        + "Azure endpoint key and requires --provider azure.",
    );
  }

  const unsetProviders = [ctx.unsetAnthropicKey && "anthropic", ctx.unsetOpenaiKey && "openai"].filter(Boolean);
  if (unsetProviders.length) {
    const setAlongside = unsetProviders.find((name) =>
      name === "anthropic" ? ctx.anthropicKeyFromFlag : ctx.openaiKeyFromFlag);
    if (setAlongside) {
      const { flag } = AUTO_PROVIDER_KEYS[setAlongside];
      throw new Error(`${flag} and --unset ${flag.slice(2)} cannot be used together.`);
    }
  }

  if (ctx.anthropicKeyPrompt) {
    ctx.anthropicKey = await promptForProviderKey("anthropic");
  }
  if (ctx.openaiKeyPrompt) {
    ctx.openaiKey = await promptForProviderKey("openai");
  }

  const anthropicKeyProvided = ctx.anthropicKeyFromFlag && Boolean(ctx.anthropicKey?.trim());
  const openaiKeyProvided = ctx.openaiKeyFromFlag && Boolean(ctx.openaiKey?.trim());

  if (!provider && !anthropicKeyProvided && !openaiKeyProvided && !unsetProviders.length) {
    printNote("Nothing to configure.");
    console.log(`  Sign in / set your key:  ${accent("nexus login")}`);
    console.log(`  Choose a provider:       ${accent("nexus configure --provider azure --base-url <url> --api-key <azure-key>")}`);
    console.log(`  Keys for Nexus Auto:     ${accent("nexus auto --anthropic-api-key")}`);
    console.log(`  Enable a harness:        ${accent("nexus <harness>")}`);
    return;
  }

  if (anthropicKeyProvided || openaiKeyProvided || unsetProviders.length) {
    const used = [
      anthropicKeyProvided && "--anthropic-api-key",
      openaiKeyProvided && "--openai-api-key",
      unsetProviders.length && "--unset",
    ].filter(Boolean).join(", ");
    warn(`\`nexus configure ${used}\` is deprecated. Use \`nexus auto\` with the same flags.`);
  }

  const existingConfig = await readGlobalConfig(home);

  // writeGlobalConfig merges — only pass what this run changes; apiKey and the
  // harness map are left untouched (login / `<harness> on` own those).
  /** @type {Parameters<typeof writeGlobalConfig>[1]} */
  const update = {};

  if (provider === "azure") {
    const baseUrl = normalizeAzureBaseUrl(ctx.baseUrlFromFlag ? ctx.baseUrl : existingConfig.azure.baseUrl);
    if (!baseUrl) {
      throw new Error(MISSING_AZURE_BASE_URL_MESSAGE);
    }
    let azureApiKey = ctx.apiKeyFromFlag ? ctx.apiKey.trim() : existingConfig.azure.apiKey;
    if (!azureApiKey && process.env[AZURE_API_KEY_ENV]?.trim()) {
      azureApiKey = AZURE_API_KEY_ENV_REF;
    }
    assertAzureApiKey(azureApiKey);
    update.provider = "azure";
    update.azure = { baseUrl, apiKey: azureApiKey };
  } else if (provider === "fireworks") {
    update.provider = "fireworks";
  }

  const savedKeys = await saveAutoProviderKeys(home, {
    anthropic: anthropicKeyProvided ? ctx.anthropicKey : "",
    openai: openaiKeyProvided ? ctx.openaiKey : "",
  });
  if (unsetProviders.length) {
    await unsetAutoProviderKeys(home, unsetProviders);
  }
  for (const savedProvider of savedKeys) {
    printSuccess(`Saved the ${AUTO_PROVIDER_KEYS[savedProvider].label} key to ~/.nexus/config.json`);
    printAutoProviderKeyReach(savedProvider);
  }
  if (!Object.keys(update).length) {
    return;
  }

  await writeGlobalConfig(home, update);

  printSuccess("Saved to ~/.nexus/config.json");
  if (update.provider === "azure") {
    printSuccess("Configured Fireworks on Microsoft Foundry provider.");
  } else if (update.provider === "fireworks") {
    printNote("Set provider to Fireworks (default).");
  }
}
