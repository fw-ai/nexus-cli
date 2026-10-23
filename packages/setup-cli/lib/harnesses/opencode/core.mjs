import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import path from "node:path";
import process from "node:process";
import {
  AZURE_API_KEY_ENV_REF,
  AZURE_OPENAI_COMPATIBLE_NPM,
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  effectiveAzureApiKey,
  lookupAzureFoundryModelLimits,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import {
  defaultMainModel,
  dropRetiredModelId,
  fireworksModelSlug,
  fullFireworksResourceId,
  isAutoModelId,
  isAutoInstantModelId,
  isFirerouterModelPattern,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { resolveManagedDisplayName } from "../../fireworks/model-display.mjs";
import { planCatalogRefresh } from "../../harness/catalog-refresh.mjs";
import { resolveFireworksCatalog } from "../../fireworks/model-specs.mjs";
import { lookupFireworksPricing } from "../../fireworks/pricing.mjs";
import {
  assumedModelsDevListed,
  hasRichFireworksLimits,
  opencodeModalitiesField,
} from "./catalog-policy.mjs";
import {
  modelsDevRegistryStatus,
  refreshModelsDevFireworksRegistry,
} from "../../fireworks/models-dev-registry.mjs";
import { lookupCachedContextLength } from "../../fireworks/serverless-catalog-cache.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { NEXUS_PROVIDERS_HEADER, RETIRED_ROUTING_PREFERENCE_HEADER, omitHeaders } from "../../firerouter/core.mjs";
import {
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { isHarnessEnabled } from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";
import { dropOpencodeProvider, mirrorOpencodeV2Providers } from "./providers-v2.mjs";
import { DATA_DIRNAME, LEGACY_DATA_DIRNAME } from "../../system/data-dir.mjs";

/**
 * Restore a raw config snapshot from a backup (or delete the config when the
 * snapshot recorded that it didn't exist), then remove the backup. Returns true
 * when it restored, false when the backup carried no snapshot.
 * @param {{ configPath: string, backupPath: string, backup: { snapshot?: { existed: boolean, raw: string }, configPath?: string } }} args
 */
export async function restoreOpencodeSnapshot({ configPath, backupPath, backup }) {
  if (!backup || backup.snapshot === undefined) {
    return false;
  }
  // Refuse to restore a snapshot taken for a different config file.
  if (backup.configPath !== undefined && backup.configPath !== path.resolve(configPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${configPath}; refusing to restore.`,
    );
  }
  if (backup.snapshot.existed) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, backup.snapshot.raw);
  } else {
    try {
      await unlink(configPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await unlink(backupPath);
  return true;
}

export const OPENCODE_CONFIG_RELATIVE_PATH = ".config/opencode/opencode.json";
export const OPENCODE_DATA_RELATIVE_DIR = ".nexus/opencode";
export const OPENCODE_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";
export const OPENCODE_FIREWORKS_PROVIDER_ID = "fireworks-ai";
export const OPENCODE_AZURE_PROVIDER_ID = "fireworks-azure";
export const OPENCODE_MANAGED_PROVIDER_IDS = [OPENCODE_FIREWORKS_PROVIDER_ID, OPENCODE_AZURE_PROVIDER_ID];

/**
 * Every opencode.json write goes through here so a v2 `providers` map can
 * never drift from the managed `provider` entries.
 * @param {string} configPath
 * @param {Record<string, any>} config
 * @param {{ mode?: number }} [opts]
 */
export async function writeOpencodeConfig(configPath, config, { mode } = {}) {
  const next = mirrorOpencodeV2Providers(config, OPENCODE_MANAGED_PROVIDER_IDS);
  await writeJson(configPath, next, { mode });
  return next;
}

function isEmptyObject(value) {
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}

/** Drop the provider id Nexus used before `fireworks-ai`; it never had a v2 mirror. */
function withoutRetiredFireworksProvider(config) {
  if (!config.provider?.fireworks) {
    return config;
  }
  const { fireworks: _retired, ...provider } = config.provider;
  return { ...config, provider };
}

/**
 * Whether Nexus should write a provider.models entry for this model.
 * Anything models.dev already lists is in OpenCode's picker under its full id,
 * so an override would only add a duplicate row. Otherwise FireRouter,
 * `auto` / `auto-*`, `-latest` router aliases, and catalog models need
 * overrides (display name, modalities, limits).
 * @param {string} modelId
 */
export function opencodeNeedsProviderModelOverride(modelId) {
  if (!modelId || typeof modelId !== "string") {
    return false;
  }
  const canonical = fullFireworksResourceId(modelId);
  const registryStatus = modelsDevRegistryStatus(canonical);
  if (registryStatus === "present") {
    return false;
  }
  if (isFirerouterModelPattern(modelId) || isAutoModelId(modelId)) {
    return true;
  }
  const slug = fireworksModelSlug(normalizeModelId(modelId));
  if (slug.endsWith("-latest") || slug.endsWith("-fast-latest")) {
    return true;
  }

  if (!canonical.startsWith("accounts/fireworks/")) {
    return false;
  }

  const limits = resolveFireworksCatalog(modelId).limits;
  if (!hasRichFireworksLimits(limits)) {
    return false;
  }

  if (registryStatus === "absent") {
    return true;
  }

  // Registry unavailable: override serverless-catalog models not assumed on models.dev.
  return Boolean(lookupCachedContextLength(canonical)) && !assumedModelsDevListed(modelId);
}

function isModelsDevDuplicate(id) {
  const canonical = fullFireworksResourceId(id);
  return canonical !== id && modelsDevRegistryStatus(canonical) === "present";
}

/**
 * Drop short-key rows (written by earlier releases) for models OpenCode now
 * lists from models.dev under their full id; they show up twice in `/models`.
 * @param {Record<string, unknown>} models
 */
export function withoutModelsDevDuplicates(models) {
  return Object.fromEntries(Object.entries(models).filter(([id]) => !isModelsDevDuplicate(id)));
}

/**
 * Model ref written to `config.model` for OpenCode. Router aliases and
 * FireRouter use short gateway slugs with provider overrides; catalog models
 * use full accounts/fireworks/... ids so models.dev can resolve them.
 * @param {string} modelId
 * @returns {string}
 */
export function opencodeConfigModelRef(modelId) {
  const stored = shortFireworksModelRef(normalizeModelId(modelId));
  if (opencodeNeedsProviderModelOverride(stored)) {
    return stored;
  }
  return fullFireworksResourceId(modelId);
}

export function effectiveOpencodeApiKey(storedKey) {
  if (!storedKey) {
    return "";
  }
  return storedKey === OPENCODE_API_KEY_ENV_REF
    ? (process.env.FIREWORKS_API_KEY ?? "")
    : storedKey;
}

export function opencodeConfigPath(home, configPath) {
  if (configPath) {
    return configPath;
  }
  return path.join(home, OPENCODE_CONFIG_RELATIVE_PATH);
}

export function opencodeDataDir(home, dataDir) {
  if (dataDir) {
    return dataDir;
  }
  return path.join(home, OPENCODE_DATA_RELATIVE_DIR);
}

// Backups are keyed by the config file they snapshot, so enabling Fireworks on
// two different opencode.json paths (e.g. via --config-path) can never restore
// one file's content onto the other.
export function opencodeBackupPath(dataDir, configPath) {
  const key = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `config-backup.${key}.json`);
}

// Raw-text snapshot (not parsed JSON) so `off` can restore the user's file
// byte-for-byte, preserving their formatting and key order.
export async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { existed: false, raw: "" };
    }
    throw error;
  }
}

export function opencodeCurrentModelId(config) {
  const modelRef = typeof config.model === "string" ? config.model : "";
  const azurePrefix = `${OPENCODE_AZURE_PROVIDER_ID}/`;
  if (modelRef.startsWith(azurePrefix)) {
    return modelRef.slice(azurePrefix.length);
  }
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  if (modelRef.startsWith(prefix)) {
    return shortFireworksModelRef(modelRef.slice(prefix.length));
  }
  if (modelRef.startsWith("fireworks/")) {
    return shortFireworksModelRef(modelRef.slice("fireworks/".length));
  }
  return null;
}

export function opencodeProviderStatus(config) {
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const azurePrefix = `${OPENCODE_AZURE_PROVIDER_ID}/`;
  const hasAzure = Boolean(config.provider?.[OPENCODE_AZURE_PROVIDER_ID]);
  const hasFireworksAi = Boolean(config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]);
  const hasLegacy = Boolean(config.provider?.fireworks);
  const model = typeof config.model === "string" ? config.model : "";
  const azureModel = model.startsWith(azurePrefix);
  if (hasAzure && azureModel) {
    return "azure";
  }
  const fireworksModel = model.startsWith(prefix) || model.startsWith("fireworks/");
  if ((hasFireworksAi || hasLegacy) && fireworksModel) {
    return "fireworks";
  }
  if (hasAzure || azureModel || hasFireworksAi || hasLegacy || fireworksModel) {
    return "custom";
  }
  return "default";
}

/**
 * @param {string} storedRef
 * @returns {"literal" | "env-reference" | "missing"}
 */
export function opencodeAuthKeyMode(storedRef) {
  if (!storedRef) {
    return "missing";
  }
  if (storedRef === OPENCODE_API_KEY_ENV_REF || storedRef === AZURE_API_KEY_ENV_REF) {
    return "env-reference";
  }
  return "literal";
}

/**
 * Build an OpenCode `provider.models` entry for a Fireworks model id.
 * Vision-capable models (including latest router aliases and FireRouter)
 * get image input modalities from the shared Fireworks model specs.
 * Latest router aliases are absent from models.dev, so limit.context/output
 * must be set explicitly or OpenCode falls back to ~128k.
 * @param {string} modelId
 * @returns {{ name: string, limit: { context: number, output: number }, modalities?: { input: string[] } }}
 */
export function buildOpencodeModelEntry(modelId) {
  const normalized = normalizeModelId(modelId);
  const { limits, input } = resolveFireworksCatalog(normalized);
  const pricing = lookupFireworksPricing(normalized);
  return {
    name: resolveManagedDisplayName(normalized),
    limit: {
      context: limits.contextWindow,
      output: limits.maxTokens,
    },
    ...(pricing
      ? {
          cost: {
            input: pricing.input,
            output: pricing.output,
            cache_read: pricing.cachedInput,
          },
        }
      : {}),
    ...(limits.vision ? { modalities: { input } } : {}),
  };
}

/**
 * Build an OpenCode `provider.models` entry for a Microsoft Foundry deployment.
 * Foundry deployment names (FW-GLM-5.2, etc.) are absent from models.dev, so
 * limit.context/output must be set from the mapped Fireworks model specs.
 * @param {string} deploymentName
 * @returns {{ name: string, limit: { context: number, output: number }, modalities?: { input: string[] } }}
 */
export function buildOpencodeAzureModelEntry(deploymentName) {
  const limits = lookupAzureFoundryModelLimits(deploymentName);
  const entry = {
    name: deploymentName,
    limit: {
      context: limits.contextWindow,
      output: limits.maxTokens,
    },
  };
  const modalities = opencodeModalitiesField(limits);
  if (modalities) {
    entry.modalities = modalities;
  }
  return entry;
}

/** Canonical `provider.models` key — collapses full resource ids and legacy prefixed refs. */
export function opencodeProviderModelKey(modelId) {
  const stored = shortFireworksModelRef(normalizeModelId(modelId));
  // Path-shaped gateway IDs (firerouter/...) must match config.model after the
  // fireworks-ai/ prefix; last-segment collapse would orphan the override.
  if (
    stored.includes("/")
    && !stored.startsWith("accounts/")
    && !stored.startsWith("fireworks-ai/")
    && !stored.startsWith("fireworks/")
  ) {
    return stored;
  }
  return fireworksModelSlug(stored);
}

function homeFromDataDir(dataDir) {
  if (path.basename(dataDir) !== "opencode" || ![DATA_DIRNAME, LEGACY_DATA_DIRNAME].includes(path.basename(path.dirname(dataDir)))) {
    return "";
  }
  return path.dirname(path.dirname(dataDir));
}

export async function enableOpencodeFireworks({
  configPath,
  dataDir,
  apiKey,
  apiKeyFromFlag = false,
  effectiveApiKey = "",
  modelId,
  byokHeaders = {},
  telemetryHeaders = {},
  catalogModelIds = [],
  catalogAvailable = catalogModelIds.length > 0,
}) {
  if (!apiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  await refreshModelsDevFireworksRegistry();

  const snapshot = await readRawIfExists(configPath);
  let config = {};
  if (snapshot.existed && snapshot.raw.trim()) {
    try {
      config = JSON.parse(snapshot.raw);
    } catch {
      throw new Error(`${configPath} is not valid JSON`);
    }
  }

  // Resolve the reference for validation/model policy, but keep the reference
  // on disk so an environment-key rotation takes effect without re-running on.
  const resolvedEffective = effectiveApiKey?.trim()
    || (apiKey === OPENCODE_API_KEY_ENV_REF ? (process.env.FIREWORKS_API_KEY ?? "") : apiKey);
  if (!resolvedEffective?.trim()) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const modelRef = typeof config.model === "string" ? config.model : "";
  // Model precedence: explicit request > model already configured by a previous
  // `on` > default. A repeat `on` without --model must not reset the user's choice.
  const currentModelId = modelRef.startsWith(prefix)
    ? modelRef.slice(prefix.length)
    : modelRef.startsWith("fireworks/")
      ? modelRef.slice("fireworks/".length)
      : "";

  // A plain re-`on` drops a carried-over FireRouter selection to `auto`;
  // (a FireRouter `--model` is rejected at admission, so `modelId` is never one from the CLI).
  const resolvedModel = normalizeModelId(modelId || dropRetiredModelId(currentModelId) || defaultMainModel());
  const storedModel = shortFireworksModelRef(resolvedModel);

  const backupPath = opencodeBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const providerStatus = opencodeProviderStatus(config);
  const hasFireconnectRouting = providerStatus === "fireworks"
    || providerStatus === "azure";
  const home = homeFromDataDir(dataDir);
  const wasGloballyEnabled = home ? await isHarnessEnabled(home, HARNESS.OPENCODE) : false;
  const shouldSnapshot = !hasBackup
    ? !hasFireconnectRouting || !wasGloballyEnabled
    : !hasFireconnectRouting;
  if (shouldSnapshot) {
    // The snapshot can contain credentials from the user's other providers —
    // keep the backup (and its directory) private to the owner.
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const base = dropOpencodeProvider(withoutRetiredFireworksProvider(config), OPENCODE_AZURE_PROVIDER_ID);
  const existing = base.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID] ?? {};
  // FireRouter BYOK header (x-anthropic-api-key) lets the gateway pass hard
  // requests through to Anthropic. Drop any stale one when none is supplied
  // (e.g. switching firerouter → a direct model). x-openai-api-key is dropped
  // too, to clean up configs written before OpenAI BYOK was removed.
  // x-fireworks-api-key is dropped because the Fireworks key belongs in
  // options.apiKey, never in a header; stripping it here clears stale keys left
  // in headers by older releases, and the retired routing-preference header
  // goes the same way.
  const byokHeaderNames = [
    "x-anthropic-api-key",
    "x-openai-api-key",
    "x-fireworks-api-key",
    NEXUS_PROVIDERS_HEADER,
    RETIRED_ROUTING_PREFERENCE_HEADER,
  ];
  const priorHeaders = Object.fromEntries(
    Object.entries(existing.options?.headers ?? {}).filter(
      ([name]) => !byokHeaderNames.includes(name.toLowerCase()),
    ),
  );
  const nextHeaders = {
    ...mergeFireconnectTelemetryHeaders(priorHeaders, telemetryHeaders),
    ...(byokHeaders ?? {}),
  };
  const storedApiKey = resolvedEffective;
  const nextOptions = { ...(existing.options ?? {}), apiKey: storedApiKey };
  if (Object.keys(nextHeaders).length > 0) {
    nextOptions.headers = nextHeaders;
  } else {
    delete nextOptions.headers;
  }
  // The registerable set carries bare `auto` (see catalogWithAutomaticAuto);
  // keep it alongside the accounts/ rows so the picker can offer it.
  const catalog = catalogModelIds.filter(
    (id) => typeof id === "string" && (id.startsWith("accounts/") || isAutoModelId(id)),
  );
  const buildModels = (ids) => {
    /** @type {Record<string, { name: string, modalities?: { input: string[] } }>} */
    const out = {};
    for (const id of ids) {
      if (!opencodeNeedsProviderModelOverride(id)) {
        continue;
      }
      const normalized = normalizeModelId(id);
      const stored = opencodeProviderModelKey(normalized);
      if (stored) {
        out[stored] = buildOpencodeModelEntry(normalized);
      }
    }
    return out;
  };
  let models = { ...(existing.models ?? {}) };
  if (Object.keys(models).length === 0) {
    // Shared fresh-install policy (see lib/harness/catalog-refresh.mjs).
    models = buildModels([storedModel, ...catalog]);
  } else if (modelId) {
    models = { ...buildModels([storedModel]), ...models };
  } else if (catalogAvailable) {
    // Shared catalog-refresh policy: prune delisted ids, add newly served
    // ones, and re-render kept rows from the fresh catalog (name, context
    // limits, cost all drift as the serverless catalog evolves).
    const keyOf = (id) => fullFireworksResourceId(opencodeProviderModelKey(id));
    const plan = planCatalogRefresh({
      currentIds: Object.keys(models).map(keyOf),
      freshIds: catalog.map(fullFireworksResourceId),
      keepUnserved: (id) => isAutoModelId(id) && !isAutoInstantModelId(id),
    });
    const keepSet = new Set(plan.kept);
    models = Object.fromEntries(
      Object.entries(models).filter(([id]) => keepSet.has(keyOf(id))),
    );
    // Fresh entries overwrite kept rows (metadata refresh) and fill the gaps.
    models = { ...models, ...buildModels(catalog) };
  }
  models = withoutModelsDevDuplicates(models);
  const hasLiteralSecret = Boolean(storedApiKey)
    || Object.keys(byokHeaders ?? {}).length > 0;
  const next = await writeOpencodeConfig(configPath, {
    ...base,
    provider: {
      ...base.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: { ...existing, options: nextOptions, models },
    },
    model: `${prefix}${opencodeConfigModelRef(resolvedModel)}`,
  }, { mode: hasLiteralSecret ? 0o600 : undefined });
  return {
    model: next.model,
    modelsAdded: Object.keys(next.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.models ?? {}),
    apiKeyMode: "literal",
  };
}

export async function enableOpencodeAzure({
  configPath,
  dataDir,
  apiKey,
  apiKeyFromFlag = false,
  baseUrl,
  modelId,
}) {
  if (!apiKey || (apiKey === AZURE_API_KEY_ENV_REF && !effectiveAzureApiKey(apiKey))) {
    throw new Error("No Azure API key found. Export AZURE_API_KEY or pass --api-key with your Foundry key.");
  }

  const normalizedBaseUrl = normalizeAzureBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error(
      "No Azure endpoint found. Pass --base-url with your Microsoft Foundry project endpoint "
      + "(e.g. https://<resource>.services.ai.azure.com).",
    );
  }

  const snapshot = await readRawIfExists(configPath);
  let config = {};
  if (snapshot.existed && snapshot.raw.trim()) {
    try {
      config = JSON.parse(snapshot.raw);
    } catch {
      throw new Error(`${configPath} is not valid JSON`);
    }
  }

  const backupPath = opencodeBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const hasFireconnectRouting = opencodeProviderStatus(config) === "fireworks"
    || opencodeProviderStatus(config) === "azure";
  const home = homeFromDataDir(dataDir);
  const wasGloballyEnabled = home ? await isHarnessEnabled(home, HARNESS.OPENCODE) : false;
  const shouldSnapshot = !hasBackup
    ? !hasFireconnectRouting || !wasGloballyEnabled
    : !hasFireconnectRouting;
  if (shouldSnapshot) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const base = dropOpencodeProvider(withoutRetiredFireworksProvider(config), OPENCODE_FIREWORKS_PROVIDER_ID);
  const existing = base.provider?.[OPENCODE_AZURE_PROVIDER_ID] ?? {};
  const resolvedModel = modelId || opencodeProviderStatus(config) === "azure"
    ? (modelId || opencodeCurrentModelId(config) || DEFAULT_AZURE_MODEL)
    : DEFAULT_AZURE_MODEL;
  const apiKeyValue = apiKeyFromFlag ? apiKey : AZURE_API_KEY_ENV_REF;
  const azureProvider = {
    ...existing,
    npm: AZURE_OPENAI_COMPATIBLE_NPM,
    name: AZURE_PROVIDER_LABEL,
    options: {
      ...(existing.options ?? {}),
      baseURL: normalizedBaseUrl,
      apiKey: apiKeyValue,
    },
    models: {
      ...(existing.models ?? {}),
      [resolvedModel]: buildOpencodeAzureModelEntry(resolvedModel),
    },
  };

  const next = await writeOpencodeConfig(configPath, {
    ...base,
    provider: { ...base.provider, [OPENCODE_AZURE_PROVIDER_ID]: azureProvider },
    model: `${OPENCODE_AZURE_PROVIDER_ID}/${resolvedModel}`,
  }, { mode: apiKeyFromFlag ? 0o600 : undefined });
  return {
    model: next.model,
    baseUrl: normalizedBaseUrl,
    apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference",
  };
}

export async function disableOpencodeFireworks({ configPath, dataDir, wasEnabled = false }) {
  const backupPath = opencodeBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const config = await readJsonIfExists(configPath);
  const hasBackup = backup.snapshot !== undefined;
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const azurePrefix = `${OPENCODE_AZURE_PROVIDER_ID}/`;
  const hasOwnedProvider = Boolean(
    config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]
      || config.provider?.[OPENCODE_AZURE_PROVIDER_ID]
      || config.provider?.fireworks,
  );
  const hasOwnedModel = typeof config.model === "string"
    && (
      config.model.startsWith(prefix)
      || config.model.startsWith(azurePrefix)
      || config.model.startsWith("fireworks/")
    );

  if (!wasEnabled && !hasBackup && !hasOwnedProvider && !hasOwnedModel) {
    return "unchanged";
  }

  if (await restoreOpencodeSnapshot({ configPath, backupPath, backup })) {
    return "restored";
  }

  // No backup: strip only what we own, and only touch the file if we actually
  // removed something — never create a config that didn't exist, and never
  // re-serialize an unrelated config.
  const { existed } = await readRawIfExists(configPath);
  if (!existed) {
    return "unchanged";
  }
  const liveConfig = await readJsonIfExists(configPath);
  let stripped = OPENCODE_MANAGED_PROVIDER_IDS.reduce(
    (config, id) => dropOpencodeProvider(config, id),
    withoutRetiredFireworksProvider(liveConfig),
  );
  if (typeof stripped.model === "string"
    && (
      stripped.model.startsWith(prefix)
      || stripped.model.startsWith(azurePrefix)
      || stripped.model.startsWith("fireworks/")
    )) {
    const { model: _model, ...rest } = stripped;
    stripped = rest;
  }
  if (stripped === liveConfig && !isEmptyObject(liveConfig.provider)) {
    return "unchanged";
  }
  if (isEmptyObject(stripped.provider)) {
    const { provider: _empty, ...rest } = stripped;
    stripped = rest;
  }
  if (stripped.providers !== liveConfig.providers && isEmptyObject(stripped.providers)) {
    const { providers: _empty, ...rest } = stripped;
    stripped = rest;
  }
  await writeJson(configPath, stripped);
  return "stripped";
}

/**
 * Re-bake the gateway `fireworks-ai` provider's `options.apiKey` after a
 * login`/rotation. Converts legacy env-reference auth to a literal. Skips
 * unmanaged providers and Azure routes.
 * @param {{ configPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>}
 */
export async function refreshOpencodeGatewayKey({ configPath, fireworksKey }) {
  const key = fireworksKey?.trim();
  if (!key) return false;
  const config = await readJsonIfExists(configPath);
  const gateway = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const current = gateway?.options?.apiKey;
  const envReference = opencodeAuthKeyMode(typeof current === "string" ? current : "") === "env-reference";
  const rotatable = typeof current === "string" && isFireworksShapedKey(current) && current !== key;
  if (!envReference && !rotatable) {
    return false;
  }
  await writeOpencodeConfig(configPath, {
    ...config,
    provider: {
      ...config.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: {
        ...gateway,
        options: { ...gateway.options, apiKey: key },
      },
    },
  }, { mode: 0o600 });
  return true;
}

/**
 * Drop saved provider keys from the gateway `fireworks-ai` provider's
 * `options.headers`, after `nexus auto --unset anthropic-api-key` / `--unset openai-api-key`.
 * @param {{ configPath: string, headerNames: string[] }} opts
 * @returns {Promise<boolean>} whether opencode.json changed
 */
export async function removeOpencodeSavedProviderKeys({ configPath, headerNames }) {
  const config = await readJsonIfExists(configPath);
  const gateway = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const headers = omitHeaders(gateway?.options?.headers, headerNames);
  if (!headers) {
    return false;
  }
  const { headers: _dropped, ...options } = gateway.options;
  await writeOpencodeConfig(configPath, {
    ...config,
    provider: {
      ...config.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: {
        ...gateway,
        options: Object.keys(headers).length ? { ...options, headers } : options,
      },
    },
  }, { mode: 0o600 });
  return true;
}
