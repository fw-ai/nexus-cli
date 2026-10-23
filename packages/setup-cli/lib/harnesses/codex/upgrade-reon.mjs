import { runHarnessCommand } from "../../cli/commands/harness.mjs";
import { parseCli } from "../../cli/parse-args.mjs";
import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { autoProviderKeysInScope } from "../../config/auto-providers.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { readJsonIfExists } from "../../io/json.mjs";
import { isRetiredModelId } from "../../fireworks/model-id.mjs";
import { missingCodexSignInRows } from "./catalog.mjs";
import {
  CODEX_PROVIDER_TABLE,
  codexCatalogPath,
  codexChatgptLoginFireworksKey,
  codexConfigPath,
  codexCurrentModelId,
  fireconnectManagedVariant,
  readCodexTomlIfExists,
} from "./core.mjs";

export const CODEX_SIGN_IN_UPGRADE_NOTE =
  "Switched Codex to its own sign-in: config.toml now sets requires_openai_auth = true and sends "
  + "your Fireworks key in the x-fireworks-api-key header, so your ChatGPT plan or the OpenAI key "
  + "you sign Codex in with pays for GPT turns. Run `codex login` if Codex asks you to sign in, "
  + "then restart Codex.";

export const CODEX_ENV_PROVIDER_KEYS_NOTE =
  "Removed the ANTHROPIC_API_KEY / OPENAI_API_KEY references an earlier FireConnect wrote into "
  + "Codex's config.toml: Nexus CLI no longer sends keys from your environment. To let Nexus Auto "
  + "use your Anthropic key in Codex, run `nexus auto --anthropic-api-key <key>`. Restart Codex to "
  + "pick it up.";

export const CODEX_SAVED_ANTHROPIC_KEY_NOTE =
  "Added the Anthropic key you saved for Nexus Auto to Codex, so auto can use Anthropic models "
  + "there. Codex's own sign-in still pays for GPT turns. Restart Codex to pick it up.";

export const CODEX_FIREROUTER_MIGRATION_NOTE =
  "FireRouter is now Nexus Auto: moved Codex to `auto` and removed the FireRouter rows from its "
  + "model list. Restart Codex to pick it up.";

export const CODEX_UPGRADE_REON_FAILURE =
  "Couldn't update Codex's Fireworks settings. Run nexus codex on.";

/**
 * Whether the gateway provider still reads a provider key from the
 * environment (`env_http_headers` naming x-anthropic-api-key or
 * x-openai-api-key), as FireConnect before Codex's sign-in mode wrote.
 * @param {Record<string, any> | undefined} table
 */
function hasEnvProviderKeyHeaders(table) {
  const headers = table?.env_http_headers;
  return Boolean(headers && typeof headers === "object"
    && Object.keys(headers).some((name) => ["x-anthropic-api-key", "x-openai-api-key"].includes(name.toLowerCase())));
}

/** @param {string[]} ids */
function modelsAddedNote(ids) {
  return `Added ${ids.join(", ")} to Codex's model list. Restart Codex to pick ${ids.length > 1 ? "them" : "it"} up.`;
}

/**
 * Why an enabled Codex needs `codex on` again after an upgrade, as the note to
 * print, or "" when its config is current. A config from before Codex's sign-in
 * mode sends the Fireworks key as a bearer token, which Codex prefers over its
 * own sign-in. A config or catalog still using FireRouter moves to `auto`,
 * and one can miss the newest GPT model of a family once the upgrade has
 * refreshed models.dev.
 * @param {string} home
 * @returns {Promise<string>}
 */
async function codexReonReason(home) {
  const { doc } = await readCodexTomlIfExists(codexConfigPath(home));
  if (fireconnectManagedVariant(doc) !== "fireworks") {
    return "";
  }
  if (!codexChatgptLoginFireworksKey(doc.tables[CODEX_PROVIDER_TABLE])) {
    return CODEX_SIGN_IN_UPGRADE_NOTE;
  }
  if (hasEnvProviderKeyHeaders(doc.tables[CODEX_PROVIDER_TABLE])) {
    return CODEX_ENV_PROVIDER_KEYS_NOTE;
  }
  const { anthropicKey } = autoProviderKeysInScope(await readGlobalConfig(home));
  const headers = doc.tables[CODEX_PROVIDER_TABLE]?.http_headers ?? {};
  if (anthropicKey && headers["x-anthropic-api-key"] !== anthropicKey) {
    return CODEX_SAVED_ANTHROPIC_KEY_NOTE;
  }
  if (isRetiredModelId(codexCurrentModelId(doc) ?? "")) {
    return CODEX_FIREROUTER_MIGRATION_NOTE;
  }
  if (!doc.root.model_catalog_json) {
    return "";
  }
  const catalog = await readJsonIfExists(codexCatalogPath(home));
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  if (models.some((row) => isRetiredModelId(row?.slug ?? ""))) {
    return CODEX_FIREROUTER_MIGRATION_NOTE;
  }
  const missing = missingCodexSignInRows(models);
  return missing.length ? modelsAddedNote(missing) : "";
}

/**
 * Re-run `codex on` the way `nexus codex on --force` does when Codex's
 * config or picker is out of date after an upgrade. `on` keeps the current
 * model, removes stale provider-key headers, rebuilds the GPT rows, and stops
 * Codex's idle background process so the next `codex` loads the result.
 * `--force` never waits on open sessions; the note says to restart Codex
 * instead. Run after the model sources are refreshed. Never throws.
 * @param {string} home
 * @param {{ run?: typeof runHarnessCommand }} [deps]
 * @returns {Promise<string[]>}
 */
export async function reapplyCodexOnUpgrade(home, { run = runHarnessCommand } = {}) {
  if (!home) {
    return [];
  }
  try {
    const { harnesses } = await readGlobalConfig(home);
    if (!isEnabledFireworksHarness(harnesses, HARNESS.CODEX)) {
      return [];
    }
    const reason = await codexReonReason(home);
    if (!reason) {
      return [];
    }
    const { route, ctx } = parseCli(["--home", home, "codex", "on", "--force"]);
    await run(route, { ...ctx, quiet: true });
    return [reason];
  } catch {
    return [CODEX_UPGRADE_REON_FAILURE];
  }
}
