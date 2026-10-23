import {
  anthropicKeyFromCustomHeaders,
  firerouterByokHeaders,
  isAnthropicShapedKey,
  isOpenAIShapedKey,
  OPENAI_BYOK_HEADER,
  openaiKeyFromCustomHeaders,
} from "./core.mjs";
import { readGlobalConfig } from "../config/global-config.mjs";
import { autoProviderKeysInScope, autoScopeAllows } from "../config/auto-providers.mjs";

/**
 * Whether a harness's config carries an Anthropic key (saved with
 * `nexus auto`) to Nexus Auto. Value harnesses embed it in config headers.
 * Claude Code doesn't: its own sign-in pays for Claude turns.
 * @param {{ byok?: "value"|"none" }|null|undefined} firerouter
 * @returns {boolean}
 */
export function supportsAnthropicApiKeyFlag(firerouter) {
  return firerouter?.byok === "value";
}

/**
 * Whether a harness's config carries an OpenAI key (saved with `nexus auto`)
 * to Nexus Auto. Value harnesses embed it in config headers, and Claude Code
 * carries it in ANTHROPIC_CUSTOM_HEADERS next to the Fireworks key.
 * @param {{ byok?: "value"|"none", customHeaderOpenaiKey?: boolean }|null|undefined} firerouter
 * @returns {boolean}
 */
export function supportsOpenaiApiKeyFlag(firerouter) {
  return firerouter?.byok === "value"
    || firerouter?.customHeaderOpenaiKey === true;
}

/**
 * Provider-key headers Nexus Auto (`auto`) reads, for harnesses whose config
 * carries per-request headers (`byok: "value"`). Each key is the one saved
 * with `nexus auto --anthropic-api-key` / `--openai-api-key`, else a header
 * already in the harness's config, so a repeat `on` keeps a key added by
 * hand. Exported ANTHROPIC_API_KEY / OPENAI_API_KEY are never read: a key in
 * the environment is often there for another tool, and sending it makes
 * Anthropic or OpenAI bill closed-model turns. Never prompts; a missing key
 * stays absent and `auto` falls back to Provider Keys or open models. While
 * the `nexus auto` scope leaves a provider out, no key is sent for it.
 *
 * @param {{ home?: string, settingsEnv?: Record<string, string>, anthropic?: boolean, openai?: boolean }} args
 *   `anthropic` / `openai`: whether this harness forwards that provider's key
 *   (false where the harness's own sign-in covers the provider)
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveAutoProviderKeyHeaders({ home = "", settingsEnv = {}, anthropic = true, openai = true }) {
  const config = home ? await readGlobalConfig(home) : null;
  const saved = autoProviderKeysInScope(config);
  const fromHarness = (value, shaped) => (shaped(value ?? "") ? value.trim() : "");
  const anthropicKey = anthropic && autoScopeAllows(config, "anthropic")
    ? saved.anthropicKey
      || fromHarness(anthropicKeyFromCustomHeaders(settingsEnv.ANTHROPIC_CUSTOM_HEADERS), isAnthropicShapedKey)
    : "";
  const openaiKey = openai && autoScopeAllows(config, "openai")
    ? saved.openaiKey || fromHarness(
      settingsEnv[OPENAI_BYOK_HEADER] ?? openaiKeyFromCustomHeaders(settingsEnv.ANTHROPIC_CUSTOM_HEADERS),
      isOpenAIShapedKey,
    )
    : "";
  return firerouterByokHeaders({ anthropicKey, openaiKey });
}
