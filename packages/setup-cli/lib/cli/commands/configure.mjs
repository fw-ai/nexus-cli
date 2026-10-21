import process from "node:process";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  MISSING_AZURE_BASE_URL_MESSAGE,
  assertAzureApiKey,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import {
  ANTHROPIC_API_KEY_ENV_REF,
  isEnabledFireworksHarness,
  OPENAI_API_KEY_ENV_REF,
  readGlobalConfig,
  writeGlobalConfig,
} from "../../config/global-config.mjs";
import {
  ANTHROPIC_BYOK_HEADER,
  isAnthropicShapedKey,
  isOpenAIShapedKey,
  OPENAI_BYOK_HEADER,
} from "../../firerouter/core.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { userSettingsPath } from "../../harnesses/claude/core.mjs";
import { readJsonIfExists } from "../../io/json.mjs";
import { removeSavedProviderKeysFromHarnesses } from "../../keys/sync.mjs";
import { accent, check } from "../../ui/term.mjs";
import { printNote, printSuccess } from "../messages.mjs";

const PROVIDER_KEYS = Object.freeze({
  anthropic: {
    label: "Anthropic",
    flag: "--anthropic-api-key",
    configField: "anthropicApiKey",
    envRef: ANTHROPIC_API_KEY_ENV_REF,
    envVar: "ANTHROPIC_API_KEY",
    header: ANTHROPIC_BYOK_HEADER,
  },
  openai: {
    label: "OpenAI",
    flag: "--openai-api-key",
    configField: "openaiApiKey",
    envRef: OPENAI_API_KEY_ENV_REF,
    envVar: "OPENAI_API_KEY",
    header: OPENAI_BYOK_HEADER,
  },
});

function listLabels(labels) {
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
}

async function claudeSignsInWithAnthropicKey(home, harnesses) {
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return false;
  }
  const settings = await readJsonIfExists(userSettingsPath(home)).catch(() => ({}));
  return isAnthropicShapedKey(settings?.env?.ANTHROPIC_API_KEY ?? "");
}

/**
 * Clear saved provider keys from the global config and from every harness
 * that holds a copy.
 *
 * @param {string} home
 * @param {Array<keyof typeof PROVIDER_KEYS>} providers
 */
async function unsetProviderKeys(home, providers) {
  const config = await readGlobalConfig(home);
  for (const provider of providers) {
    const { label, configField, envRef, envVar } = PROVIDER_KEYS[provider];
    const stored = config[configField]?.trim() ?? "";
    if (stored && stored !== envRef) {
      await writeGlobalConfig(home, { [configField]: "" });
      console.log(`${check()} Removed the saved ${label} key.`);
    } else {
      console.log(`No saved ${label} key to remove.`);
    }
    if (process.env[envVar]?.trim()) {
      console.log(`Note: ${envVar} is still set in your environment; harnesses keep sending it until you unset it.`);
    }
  }

  const headerNames = providers.map((provider) => PROVIDER_KEYS[provider].header);
  const { updated, failed } = await removeSavedProviderKeysFromHarnesses(home, headerNames);
  if (updated.length) {
    const keys = providers.length === 1 ? `the saved ${PROVIDER_KEYS[providers[0]].label} key` : "saved keys";
    const names = listLabels(updated);
    console.log(`Removed ${keys} from ${names}. Restart ${updated.length === 1 ? names : "them"} to pick that up.`);
  }
  for (const { id, label } of failed) {
    console.log(`Couldn't update ${label}'s settings. Run ${accent(`nexus ${id} off`)}, then turn it on again.`);
  }
  if (providers.includes("anthropic") && await claudeSignsInWithAnthropicKey(home, config.harnesses)) {
    console.log("Claude Code still signs in with the Anthropic key in its own settings; Nexus leaves that alone.");
  }
}
/**
 * `nexus configure` sets the non-Fireworks-key globals: the provider
 * (Fireworks vs a Microsoft Azure AI Foundry endpoint) and the provider BYOK
 * keys for FireRouter mode (Anthropic, OpenAI), which `--unset` clears.
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

  const anthropicKeyProvided = ctx.anthropicKeyFromFlag && Boolean(ctx.anthropicKey?.trim());
  const openaiKeyProvided = ctx.openaiKeyFromFlag && Boolean(ctx.openaiKey?.trim());

  const unsetProviders = [ctx.unsetAnthropicKey && "anthropic", ctx.unsetOpenaiKey && "openai"].filter(Boolean);
  if (unsetProviders.length) {
    const setAlongside = unsetProviders.find((name) =>
      name === "anthropic" ? ctx.anthropicKeyFromFlag : ctx.openaiKeyFromFlag);
    if (setAlongside) {
      const { flag } = PROVIDER_KEYS[setAlongside];
      throw new Error(`${flag} and --unset ${flag.slice(2)} cannot be used together.`);
    }
  }

  if (!provider && !anthropicKeyProvided && !openaiKeyProvided && !unsetProviders.length) {
    printNote("Nothing to configure.");
    console.log(`  Sign in / set your key:  ${accent("nexus login")}`);
    console.log(`  Choose a provider:       ${accent("nexus configure --provider azure --base-url <url> --api-key <azure-key>")}`);
    console.log(`  Set the Anthropic key:   ${accent("nexus configure --anthropic-api-key sk-ant-…")}`);
    console.log(`  Set the OpenAI key:      ${accent("nexus configure --openai-api-key sk-…")}`);
    console.log(`  Clear a saved key:       ${accent("nexus configure --unset openai-api-key")}`);
    console.log(`  Enable a harness:        ${accent("nexus <harness>")}`);
    return;
  }

  const existingConfig = await readGlobalConfig(home);

  // writeGlobalConfig merges — only pass what this run changes; apiKey and the
  // harness map are left untouched (login / `<harness> on` own those).
  /** @type {Parameters<typeof writeGlobalConfig>[1]} */
  const update = {};

  if (anthropicKeyProvided) {
    const anthropicApiKey = ctx.anthropicKey.trim();
    if (!isAnthropicShapedKey(anthropicApiKey)) {
      throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
    }
    update.anthropicApiKey = anthropicApiKey;
  }

  if (openaiKeyProvided) {
    const openaiApiKey = ctx.openaiKey.trim();
    if (!isOpenAIShapedKey(openaiApiKey)) {
      throw new Error("--openai-api-key must be an OpenAI API key (sk-..., not sk-ant-...).");
    }
    update.openaiApiKey = openaiApiKey;
  }

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

  if (unsetProviders.length) {
    await unsetProviderKeys(home, unsetProviders);
  }
  if (!Object.keys(update).length) {
    return;
  }

  await writeGlobalConfig(home, update);

  printSuccess("Saved to ~/.nexus/config.json");
  if (update.anthropicApiKey) {
    printNote("Stored Anthropic API key in global config.");
  }
  if (update.openaiApiKey) {
    printNote("Stored OpenAI API key in global config.");
  }
  if (update.provider === "azure") {
    printSuccess("Configured Fireworks on Microsoft Foundry provider.");
  } else if (update.provider === "fireworks") {
    printNote("Set provider to Fireworks (default).");
  }
}
