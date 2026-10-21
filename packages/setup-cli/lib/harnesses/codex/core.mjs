import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  defaultMainModel,
  dropRetiredModelId,
  isAutoInstantModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { isFirerouterModelPattern } from "../../fireworks/model-specs.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import { parseToml } from "./toml.mjs";
import {
  patchCodexCatalogRefRaw,
  patchCodexProviderAuthRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
} from "./toml-patch.mjs";
import {
  addCodexSelectedModel,
  buildCodexCatalogFromSnapshot,
  codexCatalogContainsModel,
  codexModelExclusionReason,
  isCodexStaleFirerouterRow,
  pruneCodexCatalogRows,
  refreshCodexCatalogRows,
  withCodexConstantFields,
  withCodexSignInRows,
} from "./catalog.mjs";
import {
  loadServerlessCatalog,
  preferLatestAliases,
} from "../../fireworks/models.mjs";
import {
  getServerlessCatalogSnapshot,
} from "../../fireworks/serverless-catalog-cache.mjs";
import { AZURE_API_KEY_ENV } from "../../fireworks/azure-core.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";
import {
  ANTHROPIC_BYOK_HEADER,
  NEXUS_PROVIDERS_HEADER,
  omitHeaders,
  OPENAI_BYOK_HEADER,
  withoutHeaders,
} from "../../firerouter/core.mjs";
export { printCodexRestartHint } from "../../cli/messages.mjs";

export const CODEX_CONFIG_RELATIVE_PATH = ".codex/config.toml";
export const CODEX_DATA_RELATIVE_DIR = ".nexus/codex";
export const CODEX_CATALOG_RELATIVE_PATH = ".codex/fireworks-model-catalog.json";
export const CODEX_CATALOG_TOML_REF = `~/${CODEX_CATALOG_RELATIVE_PATH}`;
export const CODEX_FIREWORKS_PROVIDER_ID = "fireworks-ai";
export const CODEX_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const CODEX_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";
export const CODEX_PROVIDER_TABLE = `model_providers.${CODEX_FIREWORKS_PROVIDER_ID}`;
// Foundry routing written by releases before Codex CLI 0.160 removed
// `wire_api = "chat"`. Nexus no longer writes it, but still owns it so
// `status` reports it and `off`/`uninstall` restore the pre-Nexus config.
export const CODEX_AZURE_PROVIDER_ID = "fireworks-azure";
export const CODEX_AZURE_PROVIDER_TABLE = `model_providers.${CODEX_AZURE_PROVIDER_ID}`;
export const CODEX_AZURE_API_KEY_ENV_REF = `{env:${AZURE_API_KEY_ENV}}`;
// In ChatGPT-login mode, Codex signs in with ChatGPT and sends that login as
// Authorization, so the Fireworks key moves to this header. FireRouter can use
// the ChatGPT login for GPT turns.
export const CODEX_CHATGPT_FIREWORKS_KEY_HEADER = "x-fireworks-api-key";
// What a first `codex on` selects: the `auto` mix. FireRouter selections
// are rejected at admission; stored ones are migrated off on re-`on`.
export const CODEX_DEFAULT_MODEL = defaultMainModel();
// Provider-key headers earlier releases wrote into the gateway provider. Codex's
// own sign-in pays for GPT turns now, so `on` removes them.
const CODEX_PROVIDER_KEY_HEADERS = Object.freeze([ANTHROPIC_BYOK_HEADER, OPENAI_BYOK_HEADER]);
// Headers `on` rebuilds from the current Nexus settings on every run, so a
// stale value (e.g. after `nexus auto --reset`) must not survive a re-`on`.
const CODEX_REBUILT_HEADERS = Object.freeze([...CODEX_PROVIDER_KEY_HEADERS, NEXUS_PROVIDERS_HEADER]);

export function codexConfigPath(home, configPath = "") {
  return configPath || path.join(home, CODEX_CONFIG_RELATIVE_PATH);
}

export function codexDataDir(home, dataDir = "") {
  return dataDir || path.join(home, CODEX_DATA_RELATIVE_DIR);
}

export function codexCatalogPath(home, catalogPath = "") {
  return catalogPath || path.join(home, CODEX_CATALOG_RELATIVE_PATH);
}

export function codexBackupPath(dataDir, configPath) {
  const key = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `config-backup.${key}.json`);
}

function emptyTomlDoc() {
  return { root: {}, tables: {} };
}

function readTomlDoc(raw) {
  if (!raw.trim()) {
    return emptyTomlDoc();
  }
  return parseToml(raw);
}

/**
 * The Fireworks key a ChatGPT-login provider table carries in its headers, or ""
 * when the table is not in that mode.
 * @param {Record<string, unknown> | undefined} table
 */
export function codexChatgptLoginFireworksKey(table) {
  if (!table || table.requires_openai_auth !== true) {
    return "";
  }
  const headers = table.http_headers && typeof table.http_headers === "object"
    ? table.http_headers
    : {};
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === CODEX_CHATGPT_FIREWORKS_KEY_HEADER,
  );
  return typeof entry?.[1] === "string" ? entry[1].trim() : "";
}

function isManagedProviderTable(table) {
  return table
    && table.base_url === CODEX_FIREWORKS_BASE_URL
    && (table.env_key === "FIREWORKS_API_KEY"
      || typeof table.experimental_bearer_token === "string"
      || Boolean(codexChatgptLoginFireworksKey(table)));
}

/**
 * `headers` with the Fireworks key header set to `key`, dropping any other
 * casing of the name so it is sent once.
 * @param {unknown} headers
 * @param {string} key
 */
function withChatgptLoginFireworksKey(headers, key) {
  return {
    ...withoutHeaders(headers, [CODEX_CHATGPT_FIREWORKS_KEY_HEADER]),
    [CODEX_CHATGPT_FIREWORKS_KEY_HEADER]: key,
  };
}

/**
 * Which Nexus-managed provider, if any, owns routing in this doc. The
 * `firerouter` model is served on the normal Fireworks gateway provider, so it
 * reports "fireworks" with model `firerouter` — not a distinct variant.
 * "azure" is only ever a legacy Foundry routing (see CODEX_AZURE_PROVIDER_ID).
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 * @returns {"fireworks" | "azure" | null}
 */
export function fireconnectManagedVariant(doc) {
  if (doc.root.model_provider === CODEX_FIREWORKS_PROVIDER_ID
    && typeof doc.root.model === "string"
    && doc.root.model.trim().length > 0
    && isManagedProviderTable(doc.tables[CODEX_PROVIDER_TABLE])) {
    return "fireworks";
  }
  if (doc.root.model_provider === CODEX_AZURE_PROVIDER_ID
    && doc.tables[CODEX_AZURE_PROVIDER_TABLE]) {
    return "azure";
  }
  return null;
}

/**
 * Nexus owns routing when root model_provider points at one of our
 * provider tables (Fireworks gateway or legacy Azure/Foundry).
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function fireconnectManaged(doc) {
  return fireconnectManagedVariant(doc) !== null;
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function codexCurrentModelId(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (!variant) {
    return null;
  }
  const model = doc.root.model;
  if (typeof model !== "string") {
    return null;
  }
  if (variant === "azure") {
    // Foundry deployment names are used verbatim — no accounts/ prefix.
    return model;
  }
  return shortFireworksModelRef(model);
}

/**
 * The rows of the catalog config.toml points Codex at, or [] when it points at none.
 * @param {{ root: Record<string, unknown> }} doc
 * @param {string} catalogPath
 * @returns {Promise<Array<{ slug?: string, display_name?: string }>>}
 */
export async function readCodexManagedCatalogRows(doc, catalogPath) {
  if (!doc.root.model_catalog_json) {
    return [];
  }
  const catalog = await readCodexCatalogIfValid(catalogPath);
  return Array.isArray(catalog?.models) ? catalog.models : [];
}

/**
 * Whether the saved model is a stale FireRouter row of the catalog, which a
 * re-`on` moves to bare `firerouter`.
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 * @param {Array<{ slug?: string, display_name?: string }>} rows
 */
export function codexSavesStaleFirerouterRow(doc, rows) {
  const current = codexCurrentModelId(doc);
  return Boolean(current) && rows.some((row) => isCodexStaleFirerouterRow(row) && row.slug === current);
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function codexStoredAuthRef(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (!variant) {
    return "";
  }
  const provider = variant === "azure"
    ? doc.tables[CODEX_AZURE_PROVIDER_TABLE]
    : doc.tables[CODEX_PROVIDER_TABLE];
  const bearer = provider.experimental_bearer_token;
  if (typeof bearer === "string" && bearer.trim()) {
    return bearer.trim();
  }
  if (variant === "fireworks") {
    const headerKey = codexChatgptLoginFireworksKey(provider);
    if (headerKey) {
      return headerKey;
    }
  }
  if (variant === "azure" && provider.env_key === AZURE_API_KEY_ENV) {
    return CODEX_AZURE_API_KEY_ENV_REF;
  }
  if (provider.env_key === "FIREWORKS_API_KEY") {
    return CODEX_API_KEY_ENV_REF;
  }
  return "";
}

/**
 * @param {string} storedRef
 */
export function effectiveCodexApiKey(storedRef) {
  if (!storedRef) {
    return "";
  }
  if (storedRef === CODEX_API_KEY_ENV_REF) {
    return process.env.FIREWORKS_API_KEY?.trim() ?? "";
  }
  if (storedRef === CODEX_AZURE_API_KEY_ENV_REF) {
    return process.env[AZURE_API_KEY_ENV]?.trim() ?? "";
  }
  return storedRef;
}

/**
 * @param {string} storedRef
 * @returns {"literal" | "env-reference" | "missing"}
 */
export function codexAuthKeyMode(storedRef) {
  if (!storedRef) {
    return "missing";
  }
  if (storedRef === CODEX_API_KEY_ENV_REF || storedRef === CODEX_AZURE_API_KEY_ENV_REF) {
    return "env-reference";
  }
  return "literal";
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function codexProviderStatus(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (variant) {
    return variant;
  }
  if (doc.tables[CODEX_PROVIDER_TABLE]
    || doc.tables[CODEX_AZURE_PROVIDER_TABLE]
    || doc.root.model_provider === CODEX_FIREWORKS_PROVIDER_ID
    || doc.root.model_provider === CODEX_AZURE_PROVIDER_ID) {
    return "custom";
  }
  return "default";
}

/**
 * @param {{ snapshot?: { existed: boolean, raw: string }, configPath?: string }} backup
 * @param {string} configPath
 * @param {string} backupPath
 */
function assertBackupMatchesConfig(backup, configPath, backupPath) {
  if (backup.snapshot !== undefined
    && backup.configPath !== undefined
    && backup.configPath !== path.resolve(configPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${configPath}; refusing to restore.`,
    );
  }
}

/**
 * @param {{ snapshot?: { existed: boolean, raw: string } }} backup
 */
function backupContainsManagedRouting(backup) {
  return backup.snapshot !== undefined
    && backup.snapshot.existed
    && backup.snapshot.raw.trim()
    && fireconnectManaged(readTomlDoc(backup.snapshot.raw));
}

export function snapshotReferencesFireworksCatalog(raw) {
  if (!raw.trim()) {
    return false;
  }
  const ref = readTomlDoc(raw).root.model_catalog_json;
  return typeof ref === "string" && ref.trim() === CODEX_CATALOG_TOML_REF;
}

/**
 * @param {string} catalogPath
 */
async function unlinkCatalogIfExists(catalogPath) {
  if (!catalogPath) {
    return;
  }
  try {
    await unlink(catalogPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * @param {{ snapshot: { existed: boolean, raw: string } }} backup
 * @param {string} configPath
 * @param {string} backupPath
 */
async function restoreConfigFromBackup(backup, configPath, backupPath, catalogPath = "") {
  if (backup.snapshot.existed) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, backup.snapshot.raw);
  } else {
    try {
      await unlink(configPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (backup.catalogSnapshot && catalogPath) {
    if (backup.catalogPath !== path.resolve(catalogPath)) {
      throw new Error(
        `Codex backup was taken for catalog ${backup.catalogPath}, not ${catalogPath}; refusing to restore.`,
      );
    }
    if (backup.catalogSnapshot.existed) {
      await writeFileAtomic(catalogPath, backup.catalogSnapshot.raw);
    } else {
      await unlink(catalogPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  await unlink(backupPath);
}

/**
 * @param {string} configPath
 * @param {string} raw
 */
async function stripManagedRoutingFromConfig(configPath, raw) {
  const stripped = stripFireconnectRoutingRaw(raw, { stripRootRouting: true });
  if (stripped !== raw) {
    await writeFileAtomic(configPath, stripped);
    return true;
  }
  return false;
}

async function writeCodexCatalogFile(catalogPath, catalog) {
  await writeJson(catalogPath, catalog, { mode: 0o600 });
}

/**
 * @param {string} catalogPath
 * @returns {Promise<{ models: unknown[] } | null>}
 */
async function readCodexCatalogIfValid(catalogPath) {
  try {
    const catalog = await readJsonIfExists(catalogPath);
    return catalog?.models ? catalog : null;
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(" is not valid JSON")) {
      return null;
    }
    throw error;
  }
}

function codexCatalogFetchWarning(error) {
  console.log(`Warning: could not generate model catalog: ${error.message}`);
  console.log("Codex will use default model metadata. Re-run 'nexus codex on' to retry.");
}

/**
 * Single API fetch for Codex provider registration and metadata catalog.
 * @param {string} apiKey
 * @returns {Promise<{ pickerCatalog: import("../../fireworks/models.mjs").CatalogEntry[] | null, codexCatalog: { models: unknown[] } | null, snapshot: import("../../fireworks/serverless-catalog-cache.mjs").ServerlessCatalogSnapshot | null, catalogAvailable: boolean }>}
 */
export async function loadCodexCatalogBundle(apiKey, { modelId = "" } = {}) {
  if (!apiKey) {
    return { pickerCatalog: null, codexCatalog: null, snapshot: null, catalogAvailable: false };
  }

  try {
    const loaded = await loadServerlessCatalog({ apiKey, refresh: true });
    const snapshot = getServerlessCatalogSnapshot();
    if (!snapshot) {
      throw new Error("Serverless catalog snapshot is unavailable.");
    }
    const entries = preferLatestAliases(loaded.catalog);
    const selectedRef = shortFireworksModelRef(modelId);
    const selected = snapshot.entries.find((entry) => entry.shortId === selectedRef);
    if (selected && !entries.some((entry) => entry.id === selected.id)) {
      entries.push(selected);
    }
    const preferredSnapshot = { ...snapshot, entries };
    return {
      pickerCatalog: entries,
      codexCatalog: buildCodexCatalogFromSnapshot(preferredSnapshot, loaded.rawModels),
      snapshot,
      catalogAvailable: loaded.source !== "stale",
    };
  } catch (error) {
    codexCatalogFetchWarning(error);
    return { pickerCatalog: null, codexCatalog: null, snapshot: null, catalogAvailable: false };
  }
}

export async function enableCodexFireworks({
  configPath,
  dataDir,
  apiKey,
  effectiveApiKey = "",
  apiKeyFromFlag = false,
  modelId,
  catalogPath = "",
  catalog = null,
  catalogSnapshot = null,
  catalogAvailable = false,
  refreshCatalog = false,
  telemetryHeaders = {},
}) {
  const resolvedEffective = effectiveApiKey
    || (apiKey === CODEX_API_KEY_ENV_REF ? (process.env.FIREWORKS_API_KEY ?? "") : apiKey);
  if (!resolvedEffective) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const snapshot = await readRawIfExists(configPath);
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();

  // Only reuse the current model when the gateway provider is already active —
  // switching from Foundry must not carry over a Foundry deployment name and
  // mangle it into accounts/fireworks/models/<deployment>.
  const currentGatewayModel = fireconnectManagedVariant(doc) === "fireworks"
    ? codexCurrentModelId(doc)
    : "";
  // A plain re-`on` (no explicit model) drops a carried-over FireRouter
  // selection to `auto`. A FireRouter `--model` is rejected at admission, so
  // `modelId` is never a FireRouter route from the CLI.
  const storedModel = shortFireworksModelRef(
    modelId || dropRetiredModelId(currentGatewayModel || "") || defaultMainModel(),
  );
  const exclusionReason = codexModelExclusionReason(storedModel);
  if (exclusionReason) {
    throw new Error(exclusionReason);
  }

  const backupPath = codexBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  // Only snapshot pre-Fireconnect config. If routing is already active but the
  // backup file is gone, the original cannot be recovered — re-on must not
  // snapshot the Fireworks config or off would restore routing.
  const shouldSnapshot = !hasBackup && !fireconnectManaged(doc);

  if (shouldSnapshot) {
    const catalogSnapshot = catalogPath
      ? await readRawIfExists(catalogPath)
      : { existed: false, raw: "" };
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, {
      configPath: path.resolve(configPath),
      snapshot,
      catalogPath: catalogPath ? path.resolve(catalogPath) : "",
      catalogSnapshot,
    });
    await chmod(backupPath, 0o600);
  }

  // FireRouter rows only survive when the selection itself is a FireRouter
  // route (an explicit `--model firerouter...`); every other `on` drops them,
  // stale labelled rows included.
  const withoutStaleFirerouterRows = (rows = []) => rows.filter(
    (row) => !isCodexStaleFirerouterRow(row)
      && !isAutoInstantModelId(row?.slug ?? "")
      && (isFirerouterModelPattern(storedModel) || !isFirerouterModelPattern(row?.slug ?? "")),
  );

  let effectiveCatalogPath = "";
  let catalogWritten = false;
  let catalogModelsWritten = [];
  if (catalog && catalogPath) {
    const existingCatalog = await readCodexCatalogIfValid(catalogPath);
    const managedCatalog = snapshotReferencesFireworksCatalog(snapshot.raw)
      ? existingCatalog
      : null;
    const managedModels = withoutStaleFirerouterRows(managedCatalog?.models);
    // An explicit --model keeps the existing rows; `refreshCatalog` marks a
    // model Nexus chose itself (re-`on` or the FireRouter default).
    const models = managedCatalog
      ? (modelId && !refreshCatalog
          ? managedModels
          : catalogAvailable
            ? refreshCodexCatalogRows(managedModels, catalogSnapshot, catalog.models ?? [])
            : managedModels)
      // Fresh installs seed the whole fetched catalog even when --model pins
      // one row: the catalog file drives the ChatGPT app model dropdown, so a
      // single-row file leaves no menu to pick from. The selected model is
      // appended below when it isn't in the fetched set.
      : (catalog.models ?? []);
    const catalogToWrite = {
      ...(managedCatalog ?? catalog),
      models: withCodexConstantFields(withCodexSignInRows(modelId
        ? addCodexSelectedModel(models, catalog, storedModel)
        : models)),
    };
    if ((managedCatalog || catalogToWrite.models.length > 0)
      && (!managedCatalog
        || JSON.stringify(catalogToWrite.models) !== JSON.stringify(managedCatalog.models))) {
      await writeCodexCatalogFile(catalogPath, catalogToWrite);
    }
    if (codexCatalogContainsModel(catalogToWrite, storedModel)) {
      effectiveCatalogPath = CODEX_CATALOG_TOML_REF;
      catalogWritten = true;
    }
    catalogModelsWritten = (catalogToWrite.models ?? []).map((entry) => entry.slug).filter(Boolean);
  } else if (
    catalogPath
    && existsSync(catalogPath)
    && snapshotReferencesFireworksCatalog(snapshot.raw)
  ) {
    const existingCatalog = await readCodexCatalogIfValid(catalogPath);
    const models = existingCatalog?.models ?? [];
    const keptModels = withoutStaleFirerouterRows(models);
    const nextModels = withCodexConstantFields(withCodexSignInRows(modelId
      ? addCodexSelectedModel(keptModels, null, storedModel)
      : keptModels));
    const catalogToWrite = {
      ...(existingCatalog ?? {}),
      models: nextModels,
    };
    if (JSON.stringify(nextModels) !== JSON.stringify(models)) {
      await writeCodexCatalogFile(catalogPath, catalogToWrite);
    }
    if (catalogToWrite && codexCatalogContainsModel(catalogToWrite, storedModel)) {
      effectiveCatalogPath = CODEX_CATALOG_TOML_REF;
    }
  }

  const providerTable = doc.tables[CODEX_PROVIDER_TABLE] ?? {};
  const removedProviderKeys = Boolean(
    omitHeaders(providerTable.http_headers, CODEX_PROVIDER_KEY_HEADERS)
      || omitHeaders(providerTable.env_http_headers, CODEX_PROVIDER_KEY_HEADERS),
  );
  const httpHeaders = mergeFireconnectTelemetryHeaders(
    withoutHeaders(providerTable.http_headers, CODEX_REBUILT_HEADERS),
    telemetryHeaders,
  );
  const envHttpHeaders = withoutHeaders(providerTable.env_http_headers, CODEX_REBUILT_HEADERS);
  const nextRaw = patchFireconnectRoutingRaw(snapshot.raw, {
    providerId: CODEX_FIREWORKS_PROVIDER_ID,
    baseUrl: CODEX_FIREWORKS_BASE_URL,
    modelId: storedModel,
    catalogPath: effectiveCatalogPath,
    apiKey: resolvedEffective,
    literalAuth: true,
    chatgptLogin: true,
    httpHeaders: withChatgptLoginFireworksKey(httpHeaders, resolvedEffective),
    envHttpHeaders,
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  if (nextRaw !== snapshot.raw) {
    await writeFileAtomic(configPath, nextRaw, { mode: 0o600 });
  }

  return {
    model: storedModel,
    modelsAdded: catalogWritten
      ? catalogModelsWritten
      : [storedModel],
    apiKeyMode: "literal",
    catalogWritten,
    removedProviderKeys,
  };
}

/**
 * Re-bake the gateway `[model_providers.fireworks-ai]` auth after a `login`/rotation.
 * Converts legacy env-reference auth to a literal. Azure (`fireworks-azure`) is skipped.
 * @param {{ configPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>}
 */
export async function refreshCodexGatewayKey({ configPath, fireworksKey }) {
  const key = fireworksKey?.trim();
  if (!key) return false;
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return false;
  }
  const doc = readTomlDoc(snapshot.raw);
  if (fireconnectManagedVariant(doc) !== "fireworks") {
    return false;
  }
  const stored = codexStoredAuthRef(doc);
  const provider = doc.tables[CODEX_PROVIDER_TABLE];
  if (codexChatgptLoginFireworksKey(provider)) {
    if (stored === key) {
      return false;
    }
    const nextRaw = patchCodexProviderAuthRaw(snapshot.raw, {
      apiKey: key,
      literalAuth: true,
      chatgptLogin: true,
      httpHeaders: withChatgptLoginFireworksKey(provider.http_headers, key),
    });
    await writeFileAtomic(configPath, nextRaw, { mode: 0o600 });
    return true;
  }
  const mode = codexAuthKeyMode(stored);
  if (mode === "env-reference") {
    const nextRaw = patchCodexProviderAuthRaw(snapshot.raw, { apiKey: key, literalAuth: true });
    await writeFileAtomic(configPath, nextRaw, { mode: 0o600 });
    return true;
  }
  if (!stored || !isFireworksShapedKey(stored) || stored === key) {
    return false;
  }
  const nextRaw = patchCodexProviderAuthRaw(snapshot.raw, { apiKey: key, literalAuth: true });
  await writeFileAtomic(configPath, nextRaw, { mode: 0o600 });
  return true;
}

export async function disableCodexFireworks({ configPath, dataDir, catalogPath = "", wasEnabled = false }) {
  const backupPath = codexBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const snapshot = await readRawIfExists(configPath);
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();
  const hasBackup = backup.snapshot !== undefined;

  if (!wasEnabled && !hasBackup && !fireconnectManaged(doc)) {
    if (catalogPath && !snapshotReferencesFireworksCatalog(snapshot.raw)) {
      await unlinkCatalogIfExists(catalogPath);
    }
    return "noop";
  }

  assertBackupMatchesConfig(backup, configPath, backupPath);

  if (hasBackup) {
    if (backupContainsManagedRouting(backup)) {
      await unlink(backupPath);
    } else {
      await restoreConfigFromBackup(backup, configPath, backupPath, catalogPath);
      if (!backup.catalogSnapshot && !snapshotReferencesFireworksCatalog(backup.snapshot.raw)) {
        await unlinkCatalogIfExists(catalogPath);
      }
      return "restored";
    }
  }

  if (!snapshot.existed) {
    await unlinkCatalogIfExists(catalogPath);
    return "noop";
  }

  const stripped = await stripManagedRoutingFromConfig(configPath, snapshot.raw);
  const currentSnapshot = stripped ? await readRawIfExists(configPath) : snapshot;
  if (!snapshotReferencesFireworksCatalog(currentSnapshot.raw)) {
    await unlinkCatalogIfExists(catalogPath);
  }
  return stripped ? "stripped" : "noop";
}

export async function readCodexTomlIfExists(configPath) {
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: false, doc: emptyTomlDoc() };
  }
  return { existed: true, doc: readTomlDoc(snapshot.raw) };
}
