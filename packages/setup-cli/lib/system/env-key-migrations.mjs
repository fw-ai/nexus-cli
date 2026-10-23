import { readGlobalConfig, writeGlobalConfig } from "../config/global-config.mjs";
import { opencodeConfigPath, writeOpencodeConfig } from "../harnesses/opencode/core.mjs";
import { piAuthPath, piModelsPath, readJsonFile } from "../harnesses/pi/core.mjs";
import { readJsonIfExists, writeJson } from "../io/json.mjs";

/**
 * Upgrade cleanups for what earlier FireConnect releases wrote to send
 * Anthropic and OpenAI keys from the environment. Nexus CLI no longer reads
 * those variables: keys for Nexus Auto are saved with `nexus auto`.
 *
 * The shell exports (`export ANTHROPIC_API_KEY=...` inside the
 * `# >>> fireconnect >>>` block) are removed with that whole block by the
 * rename migration and the shell-hook reconcile; Codex's `env_http_headers`
 * references go with the Codex re-`on` in `codex/upgrade-reon.mjs`.
 */

const ENV_REF = /^\{env:[A-Z0-9_]+\}$/;

/**
 * Clear `{env:ANTHROPIC_API_KEY}` / `{env:OPENAI_API_KEY}` references from
 * ~/.nexus/config.json. Literal keys stay. Never throws.
 * @param {string} home
 * @returns {Promise<boolean>} true when the config changed
 */
export async function migrateEnvProviderKeyRefsOnUpgrade(home) {
  const config = await readGlobalConfig(home);
  /** @type {Record<string, string>} */
  const update = {};
  for (const field of ["anthropicApiKey", "openaiApiKey"]) {
    if (typeof config[field] === "string" && ENV_REF.test(config[field].trim())) {
      update[field] = "";
    }
  }
  if (!Object.keys(update).length) {
    return false;
  }
  await writeGlobalConfig(home, update);
  return true;
}

// What FireConnect before 0.9 wrote when it pointed a harness's own
// Anthropic provider at FireRouter (`--router`).
const LEGACY_ROUTER_NAME = "Anthropic (FireRouter)";
const LEGACY_ROUTER_HOST = "router.fireworks.ai";
const LEGACY_ROUTER_HEADERS = ["x-fireworks-api-key", "x-firerouter-fireworks-key"];
const LEGACY_ANTHROPIC_ENV_KEYS = new Set(["{env:ANTHROPIC_API_KEY}", "$ANTHROPIC_API_KEY", "${ANTHROPIC_API_KEY}"]);

/**
 * The Anthropic key the router retarget wrote: the environment reference, or
 * the literal key it copied from FireConnect's saved key.
 * @param {unknown} value
 * @param {string} savedAnthropicKey
 */
function isLegacyRouterKey(value, savedAnthropicKey) {
  return typeof value === "string"
    && (LEGACY_ANTHROPIC_ENV_KEYS.has(value) || (Boolean(savedAnthropicKey) && value === savedAnthropicKey));
}

function isLegacyRouterUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).hostname === LEGACY_ROUTER_HOST;
  } catch {
    return false;
  }
}

/**
 * Strip the legacy router pieces from one Anthropic provider entry, in place.
 * Only an entry carrying a router marker (the display name, the router base
 * URL, or a Fireworks key header) is touched, so a user's own Anthropic
 * provider is left alone.
 * @param {Record<string, any>} entry
 * @param {{ urlField: string, headersOf: (entry: Record<string, any>) => Record<string, any> | undefined, savedAnthropicKey?: string }} shape
 *   `urlField`: the base URL key, dotted when nested (`options.baseURL`)
 * @returns {boolean} true when the entry was router-owned and changed
 */
function stripLegacyRouterEntry(entry, { urlField, headersOf, savedAnthropicKey = "" }) {
  if (!entry || typeof entry !== "object") return false;
  const holder = urlField.includes(".") ? entry[urlField.split(".")[0]] : entry;
  const urlKey = urlField.split(".").at(-1);
  const headers = headersOf(entry);
  const routerHeaders = headers && typeof headers === "object"
    ? Object.keys(headers).filter((name) => LEGACY_ROUTER_HEADERS.includes(name.toLowerCase()))
    : [];
  const owned = entry.name === LEGACY_ROUTER_NAME
    || isLegacyRouterUrl(holder?.[urlKey])
    || routerHeaders.length > 0;
  if (!owned) return false;
  if (isLegacyRouterUrl(holder?.[urlKey])) delete holder[urlKey];
  for (const name of routerHeaders) delete headers[name];
  // Older releases also sent the Anthropic key as a header from the
  // environment (`x-api-key: {env:ANTHROPIC_API_KEY}`).
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (isLegacyRouterKey(value, savedAnthropicKey)) delete headers[name];
  }
  if (entry.name === LEGACY_ROUTER_NAME) delete entry.name;
  return true;
}

function pruneEmpty(parent, key) {
  const value = parent?.[key];
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
    delete parent[key];
  }
}

/**
 * OpenCode: drop the pre-0.9 router retarget of `provider.anthropic`,
 * including the apiKey it wrote (`{env:ANTHROPIC_API_KEY}` or FireConnect's
 * saved key).
 * @param {string} home
 * @returns {Promise<boolean>}
 */
async function migrateOpencodeLegacyRouter(home, savedAnthropicKey) {
  const configPath = opencodeConfigPath(home, "");
  const config = await readJsonIfExists(configPath).catch(() => ({}));
  const anthropic = config.provider?.anthropic;
  const owned = stripLegacyRouterEntry(anthropic, {
    urlField: "options.baseURL",
    headersOf: (entry) => entry.options?.headers,
    savedAnthropicKey,
  });
  if (!owned) return false;
  if (isLegacyRouterKey(anthropic.options?.apiKey, savedAnthropicKey)) delete anthropic.options.apiKey;
  pruneEmpty(anthropic.options, "headers");
  pruneEmpty(anthropic, "options");
  pruneEmpty(config.provider, "anthropic");
  pruneEmpty(config, "provider");
  await writeOpencodeConfig(configPath, config, { mode: 0o600 });
  return true;
}

/**
 * Pi: drop the pre-0.9 router retarget of `providers.anthropic` in
 * models.json, and the Anthropic key it wrote to auth.json
 * (`$ANTHROPIC_API_KEY` or FireConnect's saved key).
 * @param {string} home
 * @returns {Promise<boolean>}
 */
async function migratePiLegacyRouter(home, savedAnthropicKey) {
  const modelsPath = piModelsPath(home);
  const models = await readJsonFile(modelsPath).catch(() => ({}));
  const anthropic = models.providers?.anthropic;
  const owned = stripLegacyRouterEntry(anthropic, {
    urlField: "baseUrl",
    headersOf: (entry) => entry.headers,
    savedAnthropicKey,
  });
  if (!owned) return false;
  pruneEmpty(anthropic, "headers");
  pruneEmpty(models.providers, "anthropic");
  pruneEmpty(models, "providers");
  await writeJson(modelsPath, models, { mode: 0o600 });

  const authPath = piAuthPath(home);
  const auth = await readJsonFile(authPath).catch(() => ({}));
  if (isLegacyRouterKey(auth.anthropic?.key, savedAnthropicKey)) {
    delete auth.anthropic;
    await writeJson(authPath, auth, { mode: 0o600 });
  }
  return true;
}

/**
 * Remove the pre-0.9 FireRouter retarget of OpenCode's and Pi's own
 * Anthropic provider, which sent `ANTHROPIC_API_KEY` from the environment to
 * a retired router host. Never throws per harness.
 * @param {string} home
 * @returns {Promise<boolean>} true when either harness changed
 */
export async function migrateLegacyRouterAnthropicProviderOnUpgrade(home) {
  const config = await readGlobalConfig(home);
  const savedAnthropicKey = typeof config.anthropicApiKey === "string" ? config.anthropicApiKey.trim() : "";
  const results = await Promise.all([
    migrateOpencodeLegacyRouter(home, savedAnthropicKey).catch(() => false),
    migratePiLegacyRouter(home, savedAnthropicKey).catch(() => false),
  ]);
  return results.some(Boolean);
}
