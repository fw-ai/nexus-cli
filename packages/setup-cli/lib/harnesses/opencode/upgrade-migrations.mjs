import { isHarnessEnabled } from "../../config/global-config.mjs";
import { dropRetiredModelId, fullFireworksResourceId, isRetiredModelId } from "../../fireworks/model-id.mjs";
import { refreshModelsDevFireworksRegistry } from "../../fireworks/models-dev-registry.mjs";
import { HARNESS } from "../../harness/id.mjs";
import {
  OPENCODE_FIREWORKS_PROVIDER_ID,
  OPENCODE_MANAGED_PROVIDER_IDS,
  opencodeConfigPath,
  opencodeProviderStatus,
  readRawIfExists,
  withoutModelsDevDuplicates,
  writeOpencodeConfig,
} from "./core.mjs";
import { mirrorOpencodeV2Providers } from "./providers-v2.mjs";

/**
 * The default opencode.json of an enabled harness, when Nexus routes it
 * through one of the given statuses.
 * @param {string} home
 * @param {ReadonlyArray<string>} statuses
 */
async function readRoutedOpencodeConfig(home, statuses) {
  if (!home || !await isHarnessEnabled(home, HARNESS.OPENCODE)) {
    return null;
  }
  const configPath = opencodeConfigPath(home);
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return null;
  }
  const config = JSON.parse(snapshot.raw);
  return statuses.includes(opencodeProviderStatus(config)) ? { configPath, config } : null;
}

/**
 * Releases through 0.9.9 wrote only `provider`, which OpenCode v2 discards
 * when the same file has a native `providers[id]`. Mirror the managed entries
 * into an existing `providers` map of a Nexus-routed config.
 * @param {string} home
 * @returns {Promise<boolean>} true when opencode.json was updated
 */
export async function migrateOpencodeV2ProvidersOnUpgrade(home) {
  const routed = await readRoutedOpencodeConfig(home, ["fireworks", "azure"]);
  if (!routed) {
    return false;
  }
  const mirrored = mirrorOpencodeV2Providers(routed.config, OPENCODE_MANAGED_PROVIDER_IDS);
  if (JSON.stringify(mirrored) === JSON.stringify(routed.config)) {
    return false;
  }
  await writeOpencodeConfig(routed.configPath, routed.config);
  return true;
}

/**
 * Move a Nexus-routed OpenCode install off FireRouter on upgrade: a
 * `model` selection naming a FireRouter route becomes the `auto` mix.
 * Provider model rows are left for the next `on`'s catalog refresh.
 * @param {string} home
 * @returns {Promise<boolean>} true when opencode.json was updated
 */
export async function migrateOpencodeFirerouterOnUpgrade(home) {
  const routed = await readRoutedOpencodeConfig(home, ["fireworks"]);
  if (!routed) {
    return false;
  }
  const { config, configPath } = routed;
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  // Re-`on` also recognizes the older `fireworks/` prefix, so a stored
  // selection may carry either spelling; both rewrite to the canonical one.
  const ref = typeof config.model === "string" && config.model.startsWith(prefix)
    ? config.model.slice(prefix.length)
    : typeof config.model === "string" && config.model.startsWith("fireworks/")
      ? config.model.slice("fireworks/".length)
      : "";
  const migrated = dropRetiredModelId(ref);
  const provider = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const models = provider?.models && typeof provider.models === "object" && !Array.isArray(provider.models)
    ? provider.models
    : {};
  const keptModels = Object.fromEntries(
    Object.entries(models).filter(([id]) => !isRetiredModelId(id)),
  );
  const headers = provider?.options?.headers && typeof provider.options.headers === "object"
    ? provider.options.headers
    : {};
  const keptHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !["x-anthropic-api-key", "x-openai-api-key"].includes(name.toLowerCase())),
  );
  const modelChanged = Boolean(ref) && migrated !== ref;
  const rowsChanged = Object.keys(keptModels).length !== Object.keys(models).length;
  const headersChanged = Object.keys(keptHeaders).length !== Object.keys(headers).length;
  if (!modelChanged && !rowsChanged && !headersChanged) {
    return false;
  }
  // BYOK headers only ever served the FireRouter route being dropped.
  await writeOpencodeConfig(configPath, {
    ...config,
    ...(modelChanged ? { model: `${prefix}${migrated}` } : {}),
    provider: {
      ...config.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: {
        ...provider,
        models: keptModels,
        options: {
          ...(provider?.options ?? {}),
          ...(Object.keys(keptHeaders).length ? { headers: keptHeaders } : { headers: undefined }),
        },
      },
    },
  });
  return true;
}

/**
 * Releases through 0.9.9 overrode router aliases under short keys that
 * models.dev now also lists, so OpenCode's `/models` showed them twice. Drop
 * those rows and point a default at a dropped key to its models.dev id. Without
 * the models.dev registry (offline), nothing changes.
 * @param {string} home
 * @returns {Promise<boolean>} true when opencode.json was updated
 */
export async function migrateOpencodePickerDuplicatesOnUpgrade(home) {
  const routed = await readRoutedOpencodeConfig(home, ["fireworks"]);
  const provider = routed?.config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const current = provider?.models;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return false;
  }
  if (!Object.keys(current).some((id) => fullFireworksResourceId(id) !== id)) {
    return false;
  }
  await refreshModelsDevFireworksRegistry();
  const models = withoutModelsDevDuplicates(current);
  if (Object.keys(models).length === Object.keys(current).length) {
    return false;
  }
  const { config, configPath } = routed;
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  // Re-`on` also recognizes the older `fireworks/` prefix, so a stored
  // selection may carry either spelling; both rewrite to the canonical one.
  const ref = typeof config.model === "string" && config.model.startsWith(prefix)
    ? config.model.slice(prefix.length)
    : typeof config.model === "string" && config.model.startsWith("fireworks/")
      ? config.model.slice("fireworks/".length)
      : "";
  const model = Object.hasOwn(current, ref) && !Object.hasOwn(models, ref)
    ? `${prefix}${fullFireworksResourceId(ref)}`
    : config.model;
  await writeOpencodeConfig(configPath, {
    ...config,
    model,
    provider: { ...config.provider, [OPENCODE_FIREWORKS_PROVIDER_ID]: { ...provider, models } },
  });
  return true;
}
