import process from "node:process";
import {
  ANTHROPIC_API_KEY_ENV_REF,
  isEnabledFireworksHarness,
  OPENAI_API_KEY_ENV_REF,
  readGlobalConfig,
  writeGlobalConfig,
} from "../config/global-config.mjs";
import { savedAutoProviderKeys } from "../config/auto-providers.mjs";
import {
  ANTHROPIC_BYOK_HEADER,
  isAnthropicShapedKey,
  isOpenAIShapedKey,
  OPENAI_BYOK_HEADER,
} from "../firerouter/core.mjs";
import { supportsAnthropicApiKeyFlag, supportsOpenaiApiKeyFlag } from "../firerouter/flag.mjs";
import { HARNESS } from "../harness/id.mjs";
import { listHarnesses } from "../harness/registry.mjs";
import { userSettingsPath } from "../harnesses/claude/core.mjs";
import { readJsonIfExists } from "../io/json.mjs";
import { removeSavedProviderKeysFromHarnesses } from "./sync.mjs";
import { accent, check } from "../ui/term.mjs";
import { readSecret } from "../ui/read-secret.mjs";
import { PROVIDER_KEYS_DOCS_URL } from "../cli/messages.mjs";

/**
 * The Anthropic and OpenAI keys `nexus auto` saves for Nexus Auto, in
 * ~/.nexus/config.json. A saved key fills in only for a provider the harness
 * has no credentials for: `ownSignIn` is the harness whose own sign-in
 * covers that provider (Claude Code's login for Anthropic, Codex's sign-in
 * for OpenAI), so it never gets that provider's saved key.
 */
export const AUTO_PROVIDER_KEYS = Object.freeze({
  anthropic: {
    label: "Anthropic",
    flag: "--anthropic-api-key",
    configField: "anthropicApiKey",
    envRef: ANTHROPIC_API_KEY_ENV_REF,
    envVar: "ANTHROPIC_API_KEY",
    header: ANTHROPIC_BYOK_HEADER,
    shaped: isAnthropicShapedKey,
    shapeHint: "an Anthropic API key (sk-ant-...)",
    ownSignIn: HARNESS.CLAUDE,
    reaches: (harness) => harness.id === HARNESS.CLAUDE_DESKTOP
      || harness.id === HARNESS.CODEX
      || supportsAnthropicApiKeyFlag(harness.firerouter),
  },
  openai: {
    label: "OpenAI",
    flag: "--openai-api-key",
    configField: "openaiApiKey",
    envRef: OPENAI_API_KEY_ENV_REF,
    envVar: "OPENAI_API_KEY",
    header: OPENAI_BYOK_HEADER,
    shaped: isOpenAIShapedKey,
    shapeHint: "an OpenAI API key (sk-..., not sk-ant-...)",
    ownSignIn: HARNESS.CODEX,
    reaches: (harness) => harness.id === HARNESS.CLAUDE_DESKTOP || supportsOpenaiApiKeyFlag(harness.firerouter),
  },
});

/** @typedef {keyof typeof AUTO_PROVIDER_KEYS} AutoKeyProvider */

function listLabels(labels) {
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
}

/**
 * Which harnesses send a saved key, which one covers that provider with its
 * own sign-in, and which cannot carry a local key. Harnesses that cannot
 * carry one are still covered by a Provider Key on the account: Provider
 * Keys are harness-agnostic and apply server-side to every harness.
 * @param {AutoKeyProvider} provider
 */
export function autoProviderKeyReach(provider) {
  const { reaches, ownSignIn } = AUTO_PROVIDER_KEYS[provider];
  const harnesses = listHarnesses();
  return {
    sends: harnesses.filter((harness) => harness.id !== ownSignIn && reaches(harness)),
    ownSignIn: harnesses.find(({ id }) => id === ownSignIn) ?? null,
    cannotCarryLocalKey: harnesses.filter((harness) => harness.id !== ownSignIn && !reaches(harness)),
  };
}

/** @param {AutoKeyProvider} provider */
export function printAutoProviderKeyReach(provider) {
  const { sends, ownSignIn, cannotCarryLocalKey } = autoProviderKeyReach(provider);
  const labels = (list) => list.map(({ label }) => label).join(", ");
  console.log(`  Nexus Auto sends it from ${labels(sends)}.`);
  if (ownSignIn) {
    console.log(`  ${ownSignIn.label} uses its own sign-in for these turns, so Nexus doesn't send it there.`);
  }
  if (cannotCarryLocalKey.length) {
    console.log(`  A Provider Key on your Fireworks account covers every harness, including ${labels(cannotCarryLocalKey)} (${PROVIDER_KEYS_DOCS_URL}).`);
  }
}

/**
 * Validate and save provider keys from `--anthropic-api-key` /
 * `--openai-api-key`. Throws before writing anything when a key has the
 * wrong shape.
 * @param {string} home
 * @param {Partial<Record<AutoKeyProvider, string>>} keys
 * @returns {Promise<AutoKeyProvider[]>} providers saved
 */
export async function saveAutoProviderKeys(home, keys) {
  /** @type {Record<string, string>} */
  const update = {};
  const saved = [];
  for (const [provider, value] of Object.entries(keys)) {
    const key = value?.trim() ?? "";
    if (!key) continue;
    const { flag, configField, shaped, shapeHint } = AUTO_PROVIDER_KEYS[/** @type {AutoKeyProvider} */ (provider)];
    if (!shaped(key)) {
      throw new Error(`${flag} must be ${shapeHint}.`);
    }
    update[configField] = key;
    saved.push(/** @type {AutoKeyProvider} */ (provider));
  }
  if (saved.length) {
    await writeGlobalConfig(home, update);
  }
  return saved;
}

/**
 * Which providers have a key saved for Nexus Auto (never the key itself).
 * @param {object} config global config
 */
export function savedAutoProviderKeyStatus(config) {
  const { anthropicKey, openaiKey } = savedAutoProviderKeys(config);
  return { anthropic: Boolean(anthropicKey), openai: Boolean(openaiKey) };
}

async function claudeSignsInWithAnthropicKey(home, harnesses) {
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return false;
  }
  const settings = await readJsonIfExists(userSettingsPath(home)).catch(() => ({}));
  return isAnthropicShapedKey(settings?.env?.ANTHROPIC_API_KEY ?? "");
}

/**
 * Prompt for a provider key given as a bare flag (`nexus auto
 * --anthropic-api-key` with no value), so the key never lands in shell
 * history or the process list. Non-TTY callers keep the old error.
 * @param {"anthropic"|"openai"} provider
 * @param {{ isTTY?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function promptForProviderKey(provider, { isTTY = process.stdin.isTTY } = {}) {
  const { flag, label } = AUTO_PROVIDER_KEYS[provider];
  if (!isTTY) {
    throw new Error(`${flag} requires a value`);
  }
  return (await readSecret(`Paste your ${label} API key: `)).trim();
}

/**
 * Clear saved provider keys from the global config and from every harness
 * that holds a copy.
 * @param {string} home
 * @param {AutoKeyProvider[]} providers
 * @param {{ stderr?: boolean }} [options] stderr keeps stdout free for --json
 */
export async function unsetAutoProviderKeys(home, providers, { stderr = false } = {}) {
  const say = stderr ? console.error : console.log;
  const config = await readGlobalConfig(home);
  for (const provider of providers) {
    const { label, configField, envRef, envVar } = AUTO_PROVIDER_KEYS[provider];
    const stored = config[configField]?.trim() ?? "";
    if (stored && stored !== envRef) {
      await writeGlobalConfig(home, { [configField]: "" });
      say(`${check()} Removed the saved ${label} key.`);
    } else {
      say(`No saved ${label} key to remove.`);
    }
    if (process.env[envVar]?.trim()) {
      say(`Note: ${envVar} is still set in your environment. Nexus CLI doesn't send it, but tools that read it directly still can until you unset it.`);
    }
  }

  const headerNames = providers.map((provider) => AUTO_PROVIDER_KEYS[provider].header);
  const { updated, failed, skipped } = await removeSavedProviderKeysFromHarnesses(home, headerNames, {
    includeDisabled: true,
    skipRunningIdes: true,
  });
  if (updated.length) {
    const keys = providers.length === 1 ? `the saved ${AUTO_PROVIDER_KEYS[providers[0]].label} key` : "saved keys";
    const names = listLabels(updated);
    say(`Removed ${keys} from ${names}. Restart ${updated.length === 1 ? names : "them"} to pick that up.`);
  }
  for (const { id, label } of failed) {
    say(`Couldn't update ${label}'s settings. Run ${accent(`nexus ${id} off`)}, then turn it on again.`);
  }
  if (skipped.length) {
    const flags = providers.map((provider) => `--unset ${AUTO_PROVIDER_KEYS[provider].flag.slice(2)}`).join(" ");
    for (const { label } of skipped) {
      say(`${label} is open, so its saved key copy is still there — quit ${label}, then run ${accent(`nexus auto ${flags}`)} again.`);
    }
  }
  if (providers.includes("anthropic") && await claudeSignsInWithAnthropicKey(home, config.harnesses)) {
    say("Claude Code still signs in with the Anthropic key in its own settings; Nexus CLI leaves that alone.");
  }
}
