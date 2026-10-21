import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  replaceFireworksKeyInCustomHeaders,
  stripCustomHeaderLines,
} from "../../firerouter/core.mjs";

export {
  CLAUDE_FIREROUTER_ENV_KEYS,
  firerouterStatusFromEnv,
} from "../../firerouter/core.mjs";

/**
 * Re-point the Fireworks key baked into Claude's custom headers at the key
 * that was just stored. Works for direct and slot-level FireRouter mappings.
 */
export async function refreshFirerouterClaudeKey({ settingsPath, fireworksKey }) {
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  const current = env.ANTHROPIC_CUSTOM_HEADERS;
  const next = replaceFireworksKeyInCustomHeaders(current, fireworksKey);
  if (next === current) {
    return false;
  }
  await writeJson(
    settingsPath,
    { ...settings, env: { ...env, ANTHROPIC_CUSTOM_HEADERS: next } },
    { mode: 0o600 },
  );
  return true;
}

/**
 * Drop saved provider keys from Claude's custom headers, after `nexus
 * configure --unset anthropic-api-key` / `--unset openai-api-key`.
 * `ANTHROPIC_API_KEY` is left alone: it is
 * Claude Code's own sign-in, and may predate Nexus.
 * @param {{ settingsPath: string, headerNames: string[] }} opts
 * @returns {Promise<boolean>} whether settings.json changed
 */
export async function removeClaudeSavedProviderKeys({ settingsPath, headerNames }) {
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  const current = env.ANTHROPIC_CUSTOM_HEADERS;
  if (typeof current !== "string") {
    return false;
  }
  const next = stripCustomHeaderLines(current, headerNames);
  if (next === stripCustomHeaderLines(current, [])) {
    return false;
  }
  const { ANTHROPIC_CUSTOM_HEADERS: _dropped, ...rest } = env;
  await writeJson(
    settingsPath,
    { ...settings, env: next ? { ...rest, ANTHROPIC_CUSTOM_HEADERS: next } : rest },
    { mode: 0o600 },
  );
  return true;
}
