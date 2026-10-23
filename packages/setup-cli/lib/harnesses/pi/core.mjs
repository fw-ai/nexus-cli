import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  defaultMainModel,
  dropRetiredModelId,
  fullFireworksResourceId,
  isAutoModelId,
  isFirerouterModelPattern,
  isRetiredModelId,
  normalizeModelId,
} from "../../fireworks/model-id.mjs";
import { resolveManagedDisplayName } from "../../fireworks/model-display.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { omitHeaders } from "../../firerouter/core.mjs";
import {
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import {
  AZURE_API_KEY_ENV,
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  lookupAzureFoundryModelLimits,
  MISSING_AZURE_API_KEY_MESSAGE,
  MISSING_AZURE_BASE_URL_MESSAGE,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import {
  fireworksInputModalities,
  lookupFireworksModelCost,
  lookupFireworksModelLimits,
} from "../../fireworks/model-specs.mjs";
import { readGlobalConfig, setHarnessState } from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { piKnownFireworksModelIds } from "./pi-catalog.mjs";
import { catalogWithAutomaticAuto, registerableModelIds } from "../../fireworks/models.mjs";
import { getServerlessCatalogSnapshot } from "../../fireworks/serverless-catalog-cache.mjs";

export const PI_SETTINGS_RELATIVE_PATH = ".pi/agent/settings.json";
export const PI_MODELS_RELATIVE_PATH = ".pi/agent/models.json";
export const PI_DATA_RELATIVE_DIR = ".nexus/pi";
export const PI_API_KEY_ENV_REF = "$FIREWORKS_API_KEY";
const PI_PROVIDER = "fireworks";
const PI_MANAGED_BY = "fireconnect";
// Pi routes Foundry through a distinct custom provider (openai-completions) so
// it never collides with the built-in Fireworks provider.
export const PI_AZURE_PROVIDER = "fireworks-azure";
export const PI_AZURE_API_KEY_ENV_REF = `$${AZURE_API_KEY_ENV}`;
const NEXUS_PROVIDERS = [PI_PROVIDER, PI_AZURE_PROVIDER];
// Appended to a user's own `enabledModels`: Pi starts on the first scoped
// model when `defaultModel` falls outside it. `**` because ids contain `/`.
const PI_FIREWORKS_SCOPE = "fireworks/**";
const PI_AZURE_SCOPE = `${PI_AZURE_PROVIDER}/**`;
// Ours, including the entries earlier releases wrote in place of the user's list.
const NEXUS_SCOPE = [
  PI_FIREWORKS_SCOPE,
  PI_AZURE_SCOPE,
  "fireworks/accounts/fireworks/routers/*",
  "fireworks/auto",
];

export function piSettingsPath(home, settingsPath = "") {
  return settingsPath || path.join(home, PI_SETTINGS_RELATIVE_PATH);
}

export function piAuthPath(home, authPath = "", settingsPath = "") {
  if (authPath) {
    return authPath;
  }
  if (settingsPath) {
    return path.join(path.dirname(settingsPath), "auth.json");
  }
  return path.join(home, ".pi/agent/auth.json");
}

export function piModelsPath(home, settingsPath = "") {
  if (settingsPath) {
    return path.join(path.dirname(settingsPath), "models.json");
  }
  return path.join(home, PI_MODELS_RELATIVE_PATH);
}

export function piDataDir(home, dataDir = "") {
  return dataDir || path.join(home, PI_DATA_RELATIVE_DIR);
}

function isNexusAuth(auth) {
  return auth?.[PI_PROVIDER]?.managedBy === PI_MANAGED_BY;
}

export function resolvePiApiKeyValue(key) {
  return key === PI_API_KEY_ENV_REF || key === "${FIREWORKS_API_KEY}"
    ? (process.env.FIREWORKS_API_KEY ?? "")
    : key;
}

/**
 * Resolve Pi's Azure key reference ($AZURE_API_KEY / ${AZURE_API_KEY}) to the
 * real environment value. Pi uses the shell `$VAR` interpolation syntax, not the
 * `{env:VAR}` form that azure-core's `effectiveAzureApiKey` understands.
 * @param {string} key
 */
export function resolvePiAzureApiKeyValue(key) {
  if (!key) {
    return "";
  }
  if (key === PI_AZURE_API_KEY_ENV_REF || key === `\${${AZURE_API_KEY_ENV}}`) {
    return process.env[AZURE_API_KEY_ENV]?.trim() ?? "";
  }
  return key;
}

export function piAuthKeyMode(key) {
  if (!key) {
    return "missing";
  }
  return key === PI_API_KEY_ENV_REF || key === "${FIREWORKS_API_KEY}" ? "env-reference" : "literal";
}

/**
 * @param {string} key
 * @returns {"literal" | "env-reference" | "missing"}
 */
export function piAzureAuthKeyMode(key) {
  if (!key) {
    return "missing";
  }
  return key === PI_AZURE_API_KEY_ENV_REF || key === `\${${AZURE_API_KEY_ENV}}`
    ? "env-reference"
    : "literal";
}

export function piProviderStatus(settings) {
  const model = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
  if (settings.defaultProvider === PI_AZURE_PROVIDER && model) {
    return "azure";
  }
  if (settings.defaultProvider === PI_PROVIDER && model) {
    return "fireworks";
  }
  if (settings.defaultProvider === PI_PROVIDER
    || settings.defaultProvider === PI_AZURE_PROVIDER) {
    return "custom";
  }
  return "default";
}

/**
 * BYOK header stored on the Nexus-managed fireworks provider (where the
 * firerouter-as-model config keeps x-anthropic-api-key).
 * @param {{ providers?: Record<string, { headers?: Record<string,string> }> }} modelsConfig
 * @returns {Record<string, string>}
 */
export function piStoredByokHeaders(modelsConfig) {
  return modelsConfig?.providers?.[PI_PROVIDER]?.headers ?? {};
}

/**
 * Drop saved provider keys from the Fireworks provider's `headers` in Pi's
 * `models.json`, after `nexus auto --unset anthropic-api-key` / `--unset openai-api-key`.
 * @param {{ modelsPath: string, headerNames: string[] }} opts
 * @returns {Promise<boolean>} whether models.json changed
 */
export async function removePiSavedProviderKeys({ modelsPath, headerNames }) {
  const modelsConfig = await readJsonFile(modelsPath);
  const provider = modelsConfig?.providers?.[PI_PROVIDER];
  const headers = omitHeaders(provider?.headers, headerNames);
  if (!headers) {
    return false;
  }
  const { headers: _dropped, ...rest } = provider;
  const next = {
    ...modelsConfig,
    providers: {
      ...modelsConfig.providers,
      [PI_PROVIDER]: Object.keys(headers).length ? { ...rest, headers } : rest,
    },
  };
  await writeJson(modelsPath, next, { mode: 0o600 });
  return true;
}

/**
 * Re-bake the Fireworks key literal in Pi's `auth.json` after a `login`/
 * rotation. Converts legacy env-reference auth to a literal.
 * @param {{ authPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>}
 */
export async function refreshPiGatewayKey({ authPath, fireworksKey }) {
  const key = fireworksKey?.trim();
  if (!key) return false;
  const auth = await readJsonFile(authPath);
  const entry = auth?.[PI_PROVIDER];
  if (entry?.managedBy !== PI_MANAGED_BY) {
    return false;
  }
  const mode = piAuthKeyMode(typeof entry.key === "string" ? entry.key : "");
  if (mode === "env-reference") {
    const next = { ...auth, [PI_PROVIDER]: { ...entry, key } };
    await writeJson(authPath, next, { mode: 0o600 });
    return true;
  }
  if (typeof entry.key !== "string"
    || !isFireworksShapedKey(entry.key)
    || entry.key === key) {
    return false;
  }
  const next = { ...auth, [PI_PROVIDER]: { ...entry, key } };
  await writeJson(authPath, next, { mode: 0o600 });
  return true;
}

export function piAzureCurrentModelId(settings) {
  if (settings.defaultProvider === PI_AZURE_PROVIDER
    && typeof settings.defaultModel === "string"
    && settings.defaultModel) {
    return settings.defaultModel;
  }
  return null;
}

/**
 * Build a Pi models.json entry for a Microsoft Foundry deployment.
 * Foundry deployment names are absent from Pi's built-in catalog, so
 * contextWindow/maxTokens must come from the mapped Fireworks model specs.
 * @param {string} deploymentName
 */
export function buildPiAzureModelEntry(deploymentName) {
  const limits = lookupAzureFoundryModelLimits(deploymentName);
  return {
    id: deploymentName,
    input: fireworksInputModalities(limits),
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
  };
}


/*
 * The integration. Nexus owns exactly these keys and nothing else:
 *   auth.json      `fireworks` (the API key)
 *   models.json    `providers.fireworks` (rows for our models Pi's catalog
 *                  lacks, plus headers)
 *                  or `providers["fireworks-azure"]`
 *   settings.json  `defaultProvider` / `defaultModel`
 * `off` deletes those keys and puts back the previous default.
 */

/**
 * Pi ships and refreshes its own Fireworks catalog with per-model `api`,
 * `compat` and `thinkingLevelMap`. A models.json row with the same id
 * replaces Pi's row and drops that tuning. These ids are never in Pi's
 * catalog: the auto mixes, FireRouter, and custom deployments.
 * @param {string} id
 */
export function isPiNexusOnlyModelId(id) {
  const canonical = fullFireworksResourceId(id ?? "");
  return Boolean(canonical) && (isAutoModelId(canonical)
    || isFirerouterModelPattern(canonical)
    || !canonical.startsWith("accounts/fireworks/"));
}

/** A models.json row for a model Pi's own catalog doesn't carry. */
export function buildPiCustomFireworksModelEntry(modelId, name) {
  const limits = lookupFireworksModelLimits(modelId);
  const cost = lookupFireworksModelCost(modelId);
  return {
    id: fullFireworksResourceId(modelId),
    name,
    reasoning: true,
    input: fireworksInputModalities(limits),
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    ...(cost ? { cost } : {}),
    compat: { sendSessionAffinityHeaders: true },
  };
}

/** Pi accepts `//` comments and trailing commas in its JSON files (its own stripper). */
function stripJsonComments(input) {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

export async function readJsonFile(filePath) {
  const snapshot = await readRawIfExists(filePath);
  if (!snapshot.existed || !snapshot.raw.trim()) return {};
  try {
    return JSON.parse(stripJsonComments(snapshot.raw.replace(/^\uFEFF/, "")));
  } catch {
    throw new Error(`${filePath} is not valid JSON`);
  }
}

async function writeJsonFile(filePath, value, mode) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  if (mode) await chmod(filePath, mode);
}

async function readPiProfile(home) {
  return home ? ((await readGlobalConfig(home)).harnesses[HARNESS.PI]?.profiles ?? {}) : {};
}

async function writePiProfile(home, profiles) {
  if (home) await setHarnessState(home, HARNESS.PI, { profiles });
}

// Releases through 0.10.0 also kept a state.json.
const LEGACY_FILE = /^state\.json$/;

async function deleteLegacyFiles(dataDir) {
  await unlink(path.join(dataDir, "state.json")).catch(() => {});
}

/*
 * Like every harness, `on` snapshots each Pi file it edits and `off` restores
 * it byte-for-byte. A later `on` keeps the first snapshot.
 */
function backupPath(dataDir, filePath, label) {
  const key = createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `${label}-backup.${key}.json`);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function snapshotOnce(dataDir, filePath, label) {
  const dest = backupPath(dataDir, filePath, label);
  if ((await readJsonIfExists(dest)).snapshot !== undefined) return;
  const snapshot = await readRawIfExists(filePath);
  const mode = snapshot.existed ? (await stat(filePath)).mode & 0o777 : undefined;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeJsonFile(dest, { filePath: path.resolve(filePath), snapshot, mode }, 0o600);
}

/** Remember what Nexus last wrote, so `off` can tell whether Pi or the user changed it since. */
async function markWritten(dataDir, filePath, label) {
  const dest = backupPath(dataDir, filePath, label);
  const backup = await readJsonIfExists(dest);
  if (backup.snapshot === undefined) return;
  await writeJsonFile(dest, { ...backup, written: sha256((await readRawIfExists(filePath)).raw ?? "") }, 0o600);
}

async function readSnapshot(dataDir, filePath, label) {
  const backup = await readJsonIfExists(backupPath(dataDir, filePath, label));
  if (backup.snapshot === undefined || (backup.filePath && backup.filePath !== path.resolve(filePath))) {
    return null;
  }
  return backup;
}

/**
 * Put `filePath` back the way it was before `on`. Byte-for-byte when nothing
 * touched it since Nexus last wrote it (or the snapshot predates that check);
 * otherwise Pi or the user changed it while on (Pi rewrites auth.json on
 * OAuth refresh and /login), so only the keys Nexus owns go back to their
 * pre-`on` values and everything else is kept.
 */
async function restoreFile(dataDir, filePath, label, revertOwnKeys, mode) {
  const backup = await readSnapshot(dataDir, filePath, label);
  const current = await readRawIfExists(filePath);
  // A file that vanished while on can only come back from the snapshot.
  const untouched = backup && (!current.existed
    || backup.written === undefined
    || backup.written === sha256(current.raw ?? ""));
  if (backup && untouched) {
    if (backup.snapshot.existed) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFileAtomic(filePath, backup.snapshot.raw);
      if (backup.mode) await chmod(filePath, backup.mode);
      else if (label === "auth") await chmod(filePath, 0o600);
    } else {
      await unlink(filePath).catch(() => {});
    }
  } else if (current.existed) {
    const before = backup?.snapshot?.existed ? parseLoose(backup.snapshot.raw) : {};
    await writeJsonFile(filePath, revertOwnKeys(await readJsonFile(filePath), before), mode);
  }
  await unlink(backupPath(dataDir, filePath, label)).catch(() => {});
}

function parseLoose(raw) {
  try {
    return JSON.parse(stripJsonComments(raw.replace(/^\uFEFF/, "")));
  } catch {
    return {};
  }
}

function withDefaults(settings, { defaultProvider, defaultModel }, scope) {
  const next = { ...settings, defaultProvider, defaultModel };
  if (defaultProvider === undefined) delete next.defaultProvider;
  if (defaultModel === undefined) delete next.defaultModel;
  if (Array.isArray(next.enabledModels)) {
    const own = next.enabledModels.filter((entry) => !NEXUS_SCOPE.includes(entry));
    if (own.length) next.enabledModels = scope ? [...own, scope] : own;
    else delete next.enabledModels;
  }
  return next;
}

function withProvider(models, id, entry) {
  const providers = { ...models.providers };
  for (const nexus of NEXUS_PROVIDERS) delete providers[nexus];
  if (entry) providers[id] = entry;
  return { ...models, providers };
}

/**
 * Whether Pi is already routed through Nexus. A `fireworks` default alone
 * isn't enough: users can point Pi at its own Fireworks provider. Nexus's
 * auth entry, or the default Nexus recorded at `on`, marks it as ours.
 */
function isNexusRouted(settings, auth, profile) {
  return settings.defaultProvider === PI_AZURE_PROVIDER
    || isNexusAuth(auth)
    || (settings.defaultProvider === PI_PROVIDER && profile.previous !== undefined);
}

/** Pi's provider status, counting a `fireworks` default only when Nexus set it up. */
export async function piNexusProviderStatus({ settingsPath, authPath, home = "" }) {
  const settings = await readJsonFile(settingsPath);
  const status = piProviderStatus(settings);
  if (status !== "fireworks") return status;
  return isNexusRouted(settings, await readJsonFile(authPath), await readPiProfile(home)) ? status : "default";
}

async function connectPi({ settingsPath, authPath, modelsPath, dataDir, home }, { provider, entry, model, scope, authEntry, modelsMode }) {
  const settings = await readJsonFile(settingsPath);
  const auth = await readJsonFile(authPath);
  const profile = await readPiProfile(home);
  const routed = isNexusRouted(settings, auth, profile);
  // Snapshot only a config Nexus isn't already routing, so a re-`on` after a
  // lost data dir can't capture Nexus's own state as the user's.
  if (!routed) {
    await snapshotOnce(dataDir, settingsPath, "settings");
    await snapshotOnce(dataDir, authPath, "auth");
    await snapshotOnce(dataDir, modelsPath, "models");
  }
  // The default to put back: the user's own, unless Pi still points at Nexus.
  const previous = routed && NEXUS_PROVIDERS.includes(settings.defaultProvider)
    ? (profile.previous ?? {})
    : { defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel };
  await writeJsonFile(settingsPath, withDefaults(settings, { defaultProvider: provider, defaultModel: model }, scope));
  await markWritten(dataDir, settingsPath, "settings");
  if (authEntry) {
    await writeJsonFile(authPath, { ...auth, [PI_PROVIDER]: authEntry }, 0o600);
    await markWritten(dataDir, authPath, "auth");
  }
  await writeJsonFile(modelsPath, withProvider(await readJsonFile(modelsPath), provider, entry), modelsMode);
  await markWritten(dataDir, modelsPath, "models");
  await writePiProfile(home, { previous });
  await deleteLegacyFiles(dataDir);
}

export async function enablePiFireworks({
  settingsPath,
  authPath,
  modelsPath,
  dataDir,
  home = "",
  apiKey,
  effectiveApiKey = "",
  modelId,
  byokHeaders = {},
  telemetryHeaders = {},
  catalogModelIds = [],
}) {
  // The resolved literal is baked into auth.json and re-baked by
  // refreshPiGatewayKey on login/rotation.
  const key = effectiveApiKey?.trim() || resolvePiApiKeyValue(apiKey ?? "");
  if (!key?.trim()) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  const settings = await readJsonFile(settingsPath);
  // A repeat `on` refreshes the key or catalog and keeps the active model —
  // except a FireRouter selection carried over from an earlier `on`, which
  // drops to `auto`. (A FireRouter `--model` is rejected at admission.)
  const current = piProviderStatus(settings) === "fireworks" ? settings.defaultModel : "";
  const model = fullFireworksResourceId(normalizeModelId(modelId || dropRetiredModelId(current || "") || defaultMainModel()));
  const headers = { ...telemetryHeaders, ...byokHeaders };
  await connectPi({ settingsPath, authPath, modelsPath, dataDir, home }, {
    provider: PI_PROVIDER,
    entry: piFireworksProvider(
      [...catalogModelIds, model],
      headers,
      piKnownFireworksModelIds({ settingsPath }),
    ),
    model,
    scope: PI_FIREWORKS_SCOPE,
    authEntry: { type: "api_key", key, managedBy: PI_MANAGED_BY },
    // FireRouter BYOK headers carry provider keys.
    modelsMode: Object.keys(byokHeaders).length ? 0o600 : undefined,
  });
  return { model, apiKeyMode: piAuthKeyMode(key) };
}

/**
 * Rows for every id in our model list that Pi's own catalog lacks. When the
 * installed Pi can't be read, only ids Pi can never know get a row.
 * @param {string[]} modelIds
 * @param {Record<string, string>} headers
 * @param {Set<string> | null} piKnownIds
 */
function piFireworksProvider(modelIds, headers, piKnownIds) {
  const ids = [...new Set(modelIds.filter(Boolean).map(fullFireworksResourceId))]
    .filter((id) => isPiNexusOnlyModelId(id) || (piKnownIds && !piKnownIds.has(id)));
  return {
    models: ids.map((id) => buildPiCustomFireworksModelEntry(id, resolveManagedDisplayName(id))),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

/**
 * Route Pi through Fireworks models served on Microsoft Foundry (Azure): a
 * custom `openai-completions` provider pointed at the Foundry resource, with
 * the Azure key (literal via --api-key, or the `$AZURE_API_KEY` reference).
 */
export async function enablePiAzure({
  settingsPath,
  authPath = "",
  modelsPath,
  dataDir,
  home = "",
  apiKey,
  apiKeyFromFlag = false,
  baseUrl,
  modelId = "",
}) {
  const normalizedBaseUrl = normalizeAzureBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error(MISSING_AZURE_BASE_URL_MESSAGE);
  }
  const effectiveApiKey = apiKey === PI_AZURE_API_KEY_ENV_REF
    ? (process.env[AZURE_API_KEY_ENV] ?? "")
    : apiKey;
  if (!effectiveApiKey) {
    throw new Error(MISSING_AZURE_API_KEY_MESSAGE);
  }
  const model = modelId || piAzureCurrentModelId(await readJsonFile(settingsPath)) || DEFAULT_AZURE_MODEL;
  await connectPi({
    settingsPath, authPath: authPath || piAuthPath("", "", settingsPath), modelsPath, dataDir, home,
  }, {
    provider: PI_AZURE_PROVIDER,
    entry: {
      name: AZURE_PROVIDER_LABEL,
      baseUrl: normalizedBaseUrl,
      api: "openai-completions",
      authHeader: true,
      apiKey: apiKeyFromFlag ? apiKey : PI_AZURE_API_KEY_ENV_REF,
      models: [buildPiAzureModelEntry(model)],
    },
    model,
    scope: PI_AZURE_SCOPE,
    modelsMode: apiKeyFromFlag ? 0o600 : undefined,
  });
  return {
    model,
    baseUrl: normalizedBaseUrl,
    apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference",
  };
}

export async function disablePiFireworks({ settingsPath, authPath, modelsPath, dataDir, home = "" }) {
  const profile = await readPiProfile(home);
  const settings = await readJsonFile(settingsPath);
  const auth = await readJsonFile(authPath);
  // A Pi the user pointed at Fireworks themselves isn't Nexus's to undo.
  const hasSnapshot = Boolean(await readSnapshot(dataDir, settingsPath, "settings"));
  if (!hasSnapshot && !isNexusRouted(settings, auth, profile)) {
    return { changed: false };
  }
  const previous = profile.previous ?? {};
  await restoreFile(dataDir, settingsPath, "settings", (current, before) => {
    if (!NEXUS_PROVIDERS.includes(current.defaultProvider)) return withDefaults(current, current);
    return withDefaults(current, hasSnapshot ? before : previous);
  });
  await restoreFile(dataDir, authPath, "auth", (current, before) => {
    if (!isNexusAuth(current)) return current;
    const { [PI_PROVIDER]: _nexus, ...rest } = current;
    return before[PI_PROVIDER] ? { ...rest, [PI_PROVIDER]: before[PI_PROVIDER] } : rest;
  }, 0o600);
  await restoreFile(dataDir, modelsPath, "models", (current, before) => {
    let next = withProvider(current);
    for (const id of NEXUS_PROVIDERS) {
      if (before.providers?.[id]) next = { ...next, providers: { ...next.providers, [id]: before.providers[id] } };
    }
    return next;
  });
  await writePiProfile(home, {});
  await deleteLegacyFiles(dataDir);
  return { changed: true };
}

/**
 * Recompute an enabled Pi's Nexus rows from the cached model list and what
 * the installed Pi knows now, without network. Runs on upgrade, which also
 * moves configs from releases through 0.10.0 to this layout: a model Pi has
 * since picked up from pi.dev loses its Nexus row, and a model new to our
 * list gains one.
 * @returns {Promise<boolean>} whether Pi's config changed
 */
export async function refreshPiCatalog({ settingsPath, authPath, modelsPath, dataDir, home = "" }) {
  const settings = await readJsonFile(settingsPath);
  if (settings.defaultProvider !== PI_PROVIDER
    || !isNexusRouted(settings, await readJsonFile(authPath), await readPiProfile(home))) {
    return false;
  }
  const models = await readJsonFile(modelsPath);
  const current = models.providers?.[PI_PROVIDER];
  // Without a cached catalog, our list is the rows Nexus already wrote: the
  // ones Pi still lacks stay, the ones Pi now carries go. FireRouter rows
  // never stay — they are retired, catalog or no catalog.
  const snapshot = getServerlessCatalogSnapshot();
  const ourIds = snapshot?.entries?.length
    ? registerableModelIds(catalogWithAutomaticAuto(
      snapshot.entries.filter(
        (entry) => !isRetiredModelId(entry?.shortId ?? "") && !isRetiredModelId(entry?.id ?? ""),
      ),
    ))
    : (current?.models ?? [])
      .map((model) => model.id)
      .filter((id) => !isRetiredModelId(String(id ?? "")));
  // An upgrade also drops a FireRouter default to the `auto` mix. Provider-key
  // headers stay: Nexus Auto reads them now.
  const model = typeof settings.defaultModel === "string"
    ? dropRetiredModelId(settings.defaultModel)
    : settings.defaultModel;
  const entry = piFireworksProvider(
    [...ourIds, model],
    current?.headers ?? {},
    piKnownFireworksModelIds({ settingsPath }),
  );
  const scopeChanged = JSON.stringify(withDefaults(settings, settings, PI_FIREWORKS_SCOPE)) !== JSON.stringify(settings);
  const legacyFiles = (await readdir(dataDir).catch(() => [])).some((name) => LEGACY_FILE.test(name));
  if (JSON.stringify(entry) === JSON.stringify(current) && !scopeChanged && !legacyFiles
    && model === settings.defaultModel) {
    return false;
  }
  await connectPi({ settingsPath, authPath, modelsPath, dataDir, home }, {
    provider: PI_PROVIDER,
    entry,
    model,
    scope: PI_FIREWORKS_SCOPE,
  });
  return true;
}
