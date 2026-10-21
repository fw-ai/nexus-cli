import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, lstat, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseDocument, stringify } from "yaml";
import {
  defaultMainModel,
  dropRetiredModelId,
  isFirerouterModelPattern,
  isRetiredModelId,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { resolveFireworksCatalog } from "../../fireworks/model-specs.mjs";
import { prettyModelName, warmServerlessPricingCache } from "../../fireworks/models.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { MISSING_FIREWORKS_API_KEY_MESSAGE } from "../../keys/key-type.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import {
  DEEPSEEK_AGENT_DEFAULT_MODEL_ENTRY_ID,
  DEEPSEEK_AGENT_DEFAULT_MODEL_PLUGIN,
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_DATA_RELATIVE_DIR,
  DEEPSEEK_DEFAULT_MODEL_NS,
  DEEPSEEK_FIREWORKS_BASE_URL,
  DEEPSEEK_FIREWORKS_PROVIDER_ID,
  DEEPSEEK_HOME_RELATIVE_DIR,
  DEEPSEEK_LLM_PI_AI_ENTRY_ID,
  DEEPSEEK_LLM_PI_AI_NS,
  DEEPSEEK_LLM_PI_AI_PLUGIN,
  DEEPSEEK_PROFILE_PATCH_FILENAME,
  DEEPSEEK_PROFILE_ROOT_FILENAME,
  DEEPSEEK_PROFILES_DIRNAME,
} from "./constants.mjs";

export {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_DATA_RELATIVE_DIR,
  DEEPSEEK_FIREWORKS_BASE_URL,
  DEEPSEEK_FIREWORKS_PROVIDER_ID,
} from "./constants.mjs";

/** @typedef {"literal" | "env-reference" | "missing"} DeepseekAuthMode */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** Resolve DeepSeek Harness home: `$DSH_HOME`, else `~/.dsh`. */
export function deepseekHomePath(home) {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv || path.join(home, DEEPSEEK_HOME_RELATIVE_DIR);
}

export function deepseekSettingsPath(home, settingsPath = "") {
  return settingsPath || path.join(deepseekHomePath(home), "settings.yaml");
}

/**
 * Credentials sit beside settings when `--config-path` overrides settings.
 * @param {string} home
 * @param {{ settingsPath?: string, credentialsPath?: string }} [opts]
 */
export function deepseekCredentialsPath(home, opts = {}) {
  if (opts.credentialsPath) {
    return opts.credentialsPath;
  }
  if (opts.settingsPath) {
    return path.join(path.dirname(opts.settingsPath), ".credentials.yaml");
  }
  return path.join(deepseekHomePath(home), ".credentials.yaml");
}

export function deepseekDataDir(home, dataDir = "") {
  return dataDir || path.join(home, DEEPSEEK_DATA_RELATIVE_DIR);
}

export function deepseekBackupPath(dataDir, settingsPath) {
  const key = createHash("sha256").update(path.resolve(settingsPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `settings-backup.${key}.json`);
}

/**
 * @param {string} raw
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function parseYamlMapping(raw, label) {
  if (!raw.trim()) {
    return {};
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid DeepSeek Harness ${label}: ${doc.errors[0].message}`);
  }
  const data = doc.toJS();
  if (data === null || data === undefined) {
    return {};
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`DeepSeek Harness ${label} must be a mapping`);
  }
  return /** @type {Record<string, unknown>} */ (data);
}

export function parseDeepseekSettings(raw) {
  return parseYamlMapping(raw, "settings.yaml");
}

export function parseDeepseekCredentials(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(parseYamlMapping(raw, ".credentials.yaml"))) {
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

function fireworksProvider(settings) {
  const providers = asPlainObject(asPlainObject(settings[DEEPSEEK_LLM_PI_AI_NS])?.providers);
  return asPlainObject(providers?.[DEEPSEEK_FIREWORKS_PROVIDER_ID]);
}

function isManagedFireworksProvider(settings) {
  const provider = fireworksProvider(settings);
  if (!provider
    || provider.apiKeyEnv !== DEEPSEEK_API_KEY_ENV
    || provider.api !== "openai-completions"
    || provider.baseURL !== DEEPSEEK_FIREWORKS_BASE_URL) {
    return false;
  }
  return asPlainObject(settings[DEEPSEEK_DEFAULT_MODEL_NS])?.provider
    === DEEPSEEK_FIREWORKS_PROVIDER_ID;
}

/** @returns {"fireworks" | null} */
export function deepseekProviderStatus(settings) {
  return isManagedFireworksProvider(settings) ? "fireworks" : null;
}

/** @returns {string | null} */
export function deepseekCurrentModelId(settings) {
  if (!isManagedFireworksProvider(settings)) {
    return null;
  }
  const model = asPlainObject(settings[DEEPSEEK_DEFAULT_MODEL_NS])?.model;
  return typeof model === "string" && model.trim()
    ? shortFireworksModelRef(model)
    : null;
}

/** @returns {DeepseekAuthMode} */
export function deepseekAuthMode(settings, credentials) {
  if (!isManagedFireworksProvider(settings)) {
    return "missing";
  }
  const stored = credentials[DEEPSEEK_API_KEY_ENV];
  return typeof stored === "string" && stored.trim() ? "literal" : "env-reference";
}

/**
 * @param {{
 *   mode: DeepseekAuthMode,
 *   credentials: Record<string, string>,
 *   envApiKey?: string,
 * }} args
 */
export function resolveDeepseekApiKey({
  mode,
  credentials,
  envApiKey = process.env.FIREWORKS_API_KEY ?? "",
}) {
  if (mode === "literal") {
    return credentials[DEEPSEEK_API_KEY_ENV]?.trim() ?? "";
  }
  if (mode === "env-reference") {
    return envApiKey.trim();
  }
  return "";
}

export async function readDeepseekSettingsIfExists(settingsPath) {
  const snapshot = await readRawIfExists(settingsPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: false, raw: "", settings: /** @type {Record<string, unknown>} */ ({}) };
  }
  return {
    existed: true,
    raw: snapshot.raw,
    settings: parseDeepseekSettings(snapshot.raw),
  };
}

export async function readDeepseekCredentialsIfExists(credentialsPath) {
  const snapshot = await readRawIfExists(credentialsPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: false, raw: "", credentials: /** @type {Record<string, string>} */ ({}) };
  }
  return {
    existed: true,
    raw: snapshot.raw,
    credentials: parseDeepseekCredentials(snapshot.raw),
  };
}

/**
 * DeepSeek Harness provider.models row from the canonical Fireworks catalog.
 * @param {string} modelId
 * @param {string} name
 */
export function buildDeepseekFireworksModelEntry(modelId, name) {
  const slug = shortFireworksModelRef(normalizeModelId(modelId));
  const { limits, cost, input } = resolveFireworksCatalog(slug);
  return {
    id: slug,
    name: name || prettyModelName(slug) || slug,
    reasoning: true,
    input,
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    ...(cost ? { cost } : {}),
  };
}

/**
 * Persist short gateway slugs (`kimi-k2p5`, `firerouter`, …) — not full
 * `accounts/fireworks/...` resource ids. Catalog limits come from the shared
 * serverless/static helpers via {@link buildDeepseekFireworksModelEntry}.
 * @param {Record<string, unknown>} settings
 * @param {{ modelId: string, modelName?: string }} opts
 */
export function patchDeepseekFireworksSettings(settings, { modelId, modelName, headers = {} }) {
  const slug = shortFireworksModelRef(normalizeModelId(modelId));
  const next = structuredClone(settings);
  const llm = asPlainObject(next[DEEPSEEK_LLM_PI_AI_NS]) ?? {};
  const providers = asPlainObject(llm.providers) ?? {};

  providers[DEEPSEEK_FIREWORKS_PROVIDER_ID] = {
    displayName: "Fireworks",
    apiKeyEnv: DEEPSEEK_API_KEY_ENV,
    api: "openai-completions",
    baseURL: DEEPSEEK_FIREWORKS_BASE_URL,
    // dsh's llm-pi-ai provider profile carries per-provider request
    // headers (`headers` dict in its schema); rebuilt wholesale here,
    // so a later `on` without them removes them again.
    ...(Object.keys(headers).length ? { headers } : {}),
    models: [buildDeepseekFireworksModelEntry(slug, modelName)],
  };
  llm.providers = providers;
  next[DEEPSEEK_LLM_PI_AI_NS] = llm;
  next[DEEPSEEK_DEFAULT_MODEL_NS] = {
    provider: DEEPSEEK_FIREWORKS_PROVIDER_ID,
    model: slug,
  };
  return next;
}

export function stripDeepseekFireworksSettings(settings) {
  const next = structuredClone(settings);
  const llm = asPlainObject(next[DEEPSEEK_LLM_PI_AI_NS]);
  if (llm) {
    const providers = asPlainObject(llm.providers);
    if (providers) {
      delete providers[DEEPSEEK_FIREWORKS_PROVIDER_ID];
      if (Object.keys(providers).length === 0) {
        delete llm.providers;
      }
    }
    if (Object.keys(llm).length === 0) {
      delete next[DEEPSEEK_LLM_PI_AI_NS];
    }
  }
  const defaults = asPlainObject(next[DEEPSEEK_DEFAULT_MODEL_NS]);
  if (defaults?.provider === DEEPSEEK_FIREWORKS_PROVIDER_ID) {
    delete next[DEEPSEEK_DEFAULT_MODEL_NS];
  }
  return next;
}

/**
 * dsh 0.1.7+ treats `$DSH_HOME/settings.yaml` as a legacy document: on the
 * first boot of a profile it imports the sections into that profile's
 * `cordis.patch.yml` — asynchronously, after the loader has settled — so the
 * boot performing the import still resolves the built-in default model
 * (provider route `deepseek-official`) and fails with MISSING_CREDENTIAL for
 * anyone without a DeepSeek key. It also imports into only the profile that
 * boots first, so profiles created later never see the route.
 *
 * dsh 0.2+ applies a home-level `$DSH_HOME/cordis.patch.yml` over every
 * profile, including ones that don't exist yet, so the route lives there.
 * Existing profile patches and settings.yaml are still written for dsh
 * releases that predate the home layer. A profile without the llm-pi-ai /
 * agent-default-model entries (`sdk-minimal`) logs a skipped-patch warning
 * for the home layer; dsh has no optional-patch form to avoid it.
 * @param {string} settingsPath
 */
export function deepseekProfilesDir(settingsPath) {
  return path.join(path.dirname(settingsPath), DEEPSEEK_PROFILES_DIRNAME);
}

/**
 * @param {string} settingsPath
 * @returns {string} the home-level patch layer dsh applies over every profile.
 */
export function deepseekHomePatchPath(settingsPath) {
  return path.join(path.dirname(settingsPath), DEEPSEEK_PROFILE_PATCH_FILENAME);
}

/**
 * Every patch file Nexus routes through: the home layer, then each
 * existing profile's own layer.
 * @param {string} settingsPath
 * @returns {Promise<string[]>}
 */
async function deepseekPatchPaths(settingsPath) {
  const profilePatches = (await listDeepseekProfileDirs(settingsPath))
    .map((dir) => path.join(dir, DEEPSEEK_PROFILE_PATCH_FILENAME));
  return [deepseekHomePatchPath(settingsPath), ...profilePatches];
}

/**
 * Profile dirs that exist on disk (identified by the `cordis.yml` root dsh
 * writes at profile init). Sorted for deterministic snapshots.
 * @param {string} settingsPath
 * @returns {Promise<string[]>}
 */
export async function listDeepseekProfileDirs(settingsPath) {
  const profilesDir = deepseekProfilesDir(settingsPath);
  let names;
  try {
    names = await readdir(profilesDir);
  } catch {
    return [];
  }
  const dirs = [];
  for (const name of names.sort()) {
    const dir = path.join(profilesDir, name);
    try {
      const dirStat = await lstat(dir);
      if (!dirStat.isDirectory()) {
        continue;
      }
      await stat(path.join(dir, DEEPSEEK_PROFILE_ROOT_FILENAME));
      dirs.push(dir);
    } catch {
      // Not an initialized profile (or unreadable) — skip.
    }
  }
  return dirs;
}

/**
 * @param {string} patchPath
 * @returns {Promise<{ existed: boolean, raw: string, entries: unknown[] }>}
 */
export async function readDeepseekProfilePatch(patchPath) {
  const snapshot = await readRawIfExists(patchPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: snapshot.existed, raw: snapshot.raw, entries: [] };
  }
  const doc = parseDocument(snapshot.raw);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid DeepSeek profile patch ${patchPath}: ${doc.errors[0].message}`);
  }
  const entries = doc.toJS();
  if (entries === null || entries === undefined) {
    return { existed: true, raw: snapshot.raw, entries: [] };
  }
  if (!Array.isArray(entries)) {
    throw new Error(`DeepSeek profile patch ${patchPath} must be a list of entries`);
  }
  return { existed: true, raw: snapshot.raw, entries };
}

/** Match a patch entry by loader id or plugin name (dsh writes both). */
function isProfilePatchEntry(entry, id, plugin) {
  if (!asPlainObject(entry)) {
    return false;
  }
  return entry.id === id || entry.name === plugin;
}

/**
 * Upsert the fireworks provider route + default model into a profile patch
 * entry list. Existing entries (and other providers under llm-pi-ai) are
 * preserved; missing entries are appended in the shape dsh's legacy-settings
 * import writes.
 * @param {unknown[]} entries
 * @param {{ modelId: string, modelName?: string }} opts
 * @returns {Record<string, unknown>[]}
 */
export function patchDeepseekProfilePatchEntries(entries, { modelId, modelName, headers = {} }) {
  const slug = shortFireworksModelRef(normalizeModelId(modelId));
  const fireworksProvider = {
    displayName: "Fireworks",
    apiKeyEnv: DEEPSEEK_API_KEY_ENV,
    api: "openai-completions",
    baseURL: DEEPSEEK_FIREWORKS_BASE_URL,
    ...(Object.keys(headers).length ? { headers } : {}),
    models: [buildDeepseekFireworksModelEntry(slug, modelName)],
  };
  /** @type {Record<string, unknown>[]} */
  const next = entries.map((entry) => structuredClone(asPlainObject(entry) ?? {}));

  let llmEntry = next.find((entry) => (
    isProfilePatchEntry(entry, DEEPSEEK_LLM_PI_AI_ENTRY_ID, DEEPSEEK_LLM_PI_AI_PLUGIN)
  ));
  if (!llmEntry) {
    llmEntry = { id: DEEPSEEK_LLM_PI_AI_ENTRY_ID, name: DEEPSEEK_LLM_PI_AI_PLUGIN, config: {} };
    next.push(llmEntry);
  }
  const llmConfig = asPlainObject(llmEntry.config) ?? {};
  const providers = asPlainObject(llmConfig.providers) ?? {};
  providers[DEEPSEEK_FIREWORKS_PROVIDER_ID] = fireworksProvider;
  llmConfig.providers = providers;
  llmEntry.config = llmConfig;

  let defaultEntry = next.find((entry) => (
    isProfilePatchEntry(entry, DEEPSEEK_AGENT_DEFAULT_MODEL_ENTRY_ID, DEEPSEEK_AGENT_DEFAULT_MODEL_PLUGIN)
  ));
  if (!defaultEntry) {
    defaultEntry = { id: DEEPSEEK_AGENT_DEFAULT_MODEL_ENTRY_ID, name: DEEPSEEK_AGENT_DEFAULT_MODEL_PLUGIN, config: {} };
    next.push(defaultEntry);
  }
  defaultEntry.config = {
    ...(asPlainObject(defaultEntry.config) ?? {}),
    provider: DEEPSEEK_FIREWORKS_PROVIDER_ID,
    model: slug,
  };
  return next;
}

/**
 * Remove only the entries Nexus owns from a profile patch: the
 * fireworks provider under llm-pi-ai (dropping the entry when nothing else
 * remains) and the agent-default-model entry only when it still points at the
 * fireworks provider. Never touches a user's own deepseek-official default.
 * @param {unknown[]} entries
 * @returns {{ entries: unknown[], changed: boolean }}
 */
export function stripDeepseekProfilePatchEntries(entries) {
  /** @type {unknown[]} */
  const next = [];
  let changed = false;
  for (const rawEntry of entries) {
    const entry = asPlainObject(rawEntry);
    if (!entry) {
      next.push(rawEntry);
      continue;
    }
    if (isProfilePatchEntry(entry, DEEPSEEK_AGENT_DEFAULT_MODEL_ENTRY_ID, DEEPSEEK_AGENT_DEFAULT_MODEL_PLUGIN)) {
      if (asPlainObject(entry.config)?.provider === DEEPSEEK_FIREWORKS_PROVIDER_ID) {
        changed = true;
        continue;
      }
      next.push(entry);
      continue;
    }
    if (isProfilePatchEntry(entry, DEEPSEEK_LLM_PI_AI_ENTRY_ID, DEEPSEEK_LLM_PI_AI_PLUGIN)) {
      const config = asPlainObject(entry.config);
      const providers = asPlainObject(config?.providers);
      if (!providers || !Object.hasOwn(providers, DEEPSEEK_FIREWORKS_PROVIDER_ID)) {
        next.push(entry);
        continue;
      }
      const nextProviders = { ...providers };
      delete nextProviders[DEEPSEEK_FIREWORKS_PROVIDER_ID];
      const nextConfig = { ...(config ?? {}) };
      if (Object.keys(nextProviders).length > 0) {
        nextConfig.providers = nextProviders;
      } else {
        delete nextConfig.providers;
      }
      if (Object.keys(nextConfig).length === 0) {
        changed = true;
        continue;
      }
      next.push({ ...entry, config: nextConfig });
      changed = true;
      continue;
    }
    next.push(entry);
  }
  return { entries: next, changed };
}

/**
 * Nexus-managed state in a profile patch, if any.
 * @param {unknown[]} entries
 * @returns {{ provider: "fireworks" | null, model: string | null }}
 */
export function deepseekProfilePatchFireworksState(entries) {
  for (const rawEntry of entries) {
    const entry = asPlainObject(rawEntry);
    if (!entry || !isProfilePatchEntry(entry, DEEPSEEK_LLM_PI_AI_ENTRY_ID, DEEPSEEK_LLM_PI_AI_PLUGIN)) {
      continue;
    }
    const providers = asPlainObject(asPlainObject(entry.config)?.providers);
    const provider = asPlainObject(providers?.[DEEPSEEK_FIREWORKS_PROVIDER_ID]);
    if (!provider || provider.apiKeyEnv !== DEEPSEEK_API_KEY_ENV) {
      continue;
    }
    let model = null;
    for (const other of entries) {
      const candidate = asPlainObject(other);
      if (!candidate || !isProfilePatchEntry(candidate, DEEPSEEK_AGENT_DEFAULT_MODEL_ENTRY_ID, DEEPSEEK_AGENT_DEFAULT_MODEL_PLUGIN)) {
        continue;
      }
      const config = asPlainObject(candidate.config);
      if (config?.provider === DEEPSEEK_FIREWORKS_PROVIDER_ID && typeof config.model === "string") {
        model = config.model.trim() || null;
      }
    }
    return { provider: "fireworks", model };
  }
  return { provider: null, model: null };
}

/**
 * Effective routing state: the legacy settings document first, then every
 * profile patch (dsh 0.1.7+ migrates settings.yaml into the patch, so the
 * file can be gone while the route still lives in a profile).
 * @param {string} settingsPath
 * @param {Record<string, unknown>} settings
 * @returns {Promise<{ provider: "fireworks" | null, model: string | null }>}
 */
export async function deepseekEffectiveFireworksState(settingsPath, settings) {
  if (isManagedFireworksProvider(settings)) {
    const model = asPlainObject(settings[DEEPSEEK_DEFAULT_MODEL_NS])?.model;
    return {
      provider: "fireworks",
      model: typeof model === "string" && model.trim() ? shortFireworksModelRef(model) : null,
    };
  }
  for (const patchPath of await deepseekPatchPaths(settingsPath)) {
    let patch;
    try {
      patch = await readDeepseekProfilePatch(patchPath);
    } catch {
      continue;
    }
    const state = deepseekProfilePatchFireworksState(patch.entries);
    if (state.provider === "fireworks") {
      return state;
    }
  }
  return { provider: null, model: null };
}

function serializeYaml(doc) {
  if (Object.keys(doc).length === 0) {
    return "";
  }
  return `${stringify(doc, { lineWidth: 0 }).trimEnd()}\n`;
}

/** Patch files are a top-level entry list; an empty list must stay `[]`. */
function serializeProfilePatch(entries) {
  if (entries.length === 0) {
    return "[]\n";
  }
  return `${stringify(entries, { lineWidth: 0 }).trimEnd()}\n`;
}

/**
 * @param {{
 *   settingsPath: string,
 *   credentialsPath: string,
 *   dataDir: string,
 *   effectiveApiKey: string,
 *   modelId?: string,
 * }} args
 */
/**
 * Snapshot a profile patch as the pre-Nexus original. A patch left
 * dirty by a previous `on` whose backup was lost or never run `off` is
 * snapshotted with Nexus-owned entries stripped, so restoring it can
 * never resurrect the fireworks route.
 * @param {string} patchPath
 * @returns {Promise<{ existed: boolean, raw: string }>}
 */
async function snapshotProfilePatchOriginal(patchPath) {
  const snap = await readRawIfExists(patchPath);
  if (!snap.existed || !snap.raw.trim()) {
    return { existed: snap.existed, raw: snap.raw };
  }
  let patch;
  try {
    patch = await readDeepseekProfilePatch(patchPath);
  } catch {
    return { existed: snap.existed, raw: snap.raw };
  }
  if (deepseekProfilePatchFireworksState(patch.entries).provider !== "fireworks") {
    return { existed: snap.existed, raw: snap.raw };
  }
  const { entries } = stripDeepseekProfilePatchEntries(patch.entries);
  return { existed: true, raw: serializeProfilePatch(entries) };
}

export async function enableDeepseekFireworks({
  settingsPath,
  credentialsPath,
  dataDir,
  effectiveApiKey: effectiveApiKeyInput = "",
  modelId,
  headers = {},
}) {
  const effectiveApiKey = effectiveApiKeyInput.trim();
  if (!effectiveApiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const [settingsSnap, credentialsSnap] = await Promise.all([
    readDeepseekSettingsIfExists(settingsPath),
    readDeepseekCredentialsIfExists(credentialsPath),
  ]);

  await warmServerlessPricingCache(effectiveApiKey);

  // A plain re-`on` drops a carried-over FireRouter selection to `auto`;
  // (a FireRouter `--model` is rejected at admission, so `modelId` is never one from the CLI).
  const effectiveModelId = modelId
    || dropRetiredModelId(deepseekCurrentModelId(settingsSnap.settings) || "")
    || defaultMainModel();
  const storedModel = shortFireworksModelRef(normalizeModelId(effectiveModelId));

  const backupPath = deepseekBackupPath(dataDir, settingsPath);
  const existingBackup = await readJsonIfExists(backupPath);
  const shouldSnapshot = existingBackup.settingsSnapshot === undefined
    && !isManagedFireworksProvider(settingsSnap.settings);

  // dsh 0.1.7+ composes `cordis.patch.yml` layers; snapshot each patch once
  // (first touch) so `off` restores byte-for-byte.
  const patchPaths = await deepseekPatchPaths(settingsPath);
  const patchSnapshots = { ...(existingBackup.profilePatchSnapshots ?? {}) };
  let addedPatchSnapshot = false;
  for (const patchPath of patchPaths) {
    const key = path.resolve(patchPath);
    if (patchSnapshots[key] !== undefined) {
      continue;
    }
    patchSnapshots[key] = await snapshotProfilePatchOriginal(patchPath);
    addedPatchSnapshot = true;
  }

  if (shouldSnapshot || addedPatchSnapshot) {
    const backup = {
      settingsPath: path.resolve(settingsPath),
      credentialsPath: path.resolve(credentialsPath),
      ...(shouldSnapshot || existingBackup.settingsSnapshot !== undefined
        ? {
          settingsSnapshot: existingBackup.settingsSnapshot ?? {
            existed: settingsSnap.existed,
            raw: settingsSnap.raw,
          },
          credentialsSnapshot: existingBackup.credentialsSnapshot ?? {
            existed: credentialsSnap.existed,
            raw: credentialsSnap.raw,
          },
        }
        : {}),
      profilePatchSnapshots: patchSnapshots,
    };
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, backup);
    await chmod(backupPath, 0o600);
  }

  const nextSettings = patchDeepseekFireworksSettings(settingsSnap.settings, {
    modelId: storedModel,
    headers,
  });
  const nextCredentials = {
    ...credentialsSnap.credentials,
    [DEEPSEEK_API_KEY_ENV]: effectiveApiKey,
  };

  await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(settingsPath, serializeYaml(nextSettings), { mode: 0o600 });
  await writeFileAtomic(credentialsPath, serializeYaml(nextCredentials), { mode: 0o600 });

  // Patch the home layer and every existing profile directly so the fireworks
  // route is active on the very next dsh boot — a legacy settings.yaml import
  // only takes effect on the boot *after* the one that performs it.
  for (const patchPath of patchPaths) {
    let patch;
    try {
      patch = await readDeepseekProfilePatch(patchPath);
    } catch {
      continue; // Unparseable user patch (e.g. !!js expressions) — leave it alone.
    }
    const raw = serializeProfilePatch(patchDeepseekProfilePatchEntries(patch.entries, { modelId: storedModel, headers }));
    await writeFileAtomic(patchPath, raw, { mode: 0o600 });
  }

  return {
    model: storedModel,
    modelsAdded: [storedModel],
    modelSpec: `${DEEPSEEK_FIREWORKS_PROVIDER_ID}:${storedModel}`,
    authMode: "literal",
    apiKeyMode: "literal",
  };
}

/**
 * Move a Nexus-routed DeepSeek install off FireRouter without a key or a
 * snapshot: rewrite only the model in the settings layer and every patch
 * layer whose Fireworks default names a FireRouter route, preserving each
 * layer's headers and entries. Credentials and backups are untouched, so
 * `off` still restores the pre-`on` originals.
 * @param {{ settingsPath: string }} args
 * @returns {Promise<boolean>} true when any layer was rewritten
 */
export async function migrateDeepseekFirerouterModel({ settingsPath }) {
  const settingsSnap = await readDeepseekSettingsIfExists(settingsPath);
  const effective = await deepseekEffectiveFireworksState(settingsPath, settingsSnap.settings);
  if (effective.provider !== "fireworks" || !isRetiredModelId(effective.model ?? "")) {
    return false;
  }
  const target = defaultMainModel();
  let changed = false;
  if (isRetiredModelId(deepseekCurrentModelId(settingsSnap.settings) ?? "")) {
    const provider = fireworksProvider(settingsSnap.settings);
    await writeFileAtomic(settingsPath, serializeYaml(patchDeepseekFireworksSettings(settingsSnap.settings, {
      modelId: target,
      headers: asPlainObject(provider?.headers) ?? {},
    })), { mode: 0o600 });
    changed = true;
  }
  for (const patchPath of await deepseekPatchPaths(settingsPath)) {
    let patch;
    try {
      patch = await readDeepseekProfilePatch(patchPath);
    } catch {
      continue; // Unparseable user patch — leave it alone (same rule as `on`).
    }
    const state = deepseekProfilePatchFireworksState(patch.entries);
    if (state.provider !== "fireworks" || !isRetiredModelId(state.model ?? "")) {
      continue;
    }
    let headers = {};
    for (const rawEntry of patch.entries) {
      const entry = asPlainObject(rawEntry);
      if (entry && isProfilePatchEntry(entry, DEEPSEEK_LLM_PI_AI_ENTRY_ID, DEEPSEEK_LLM_PI_AI_PLUGIN)) {
        headers = asPlainObject(asPlainObject(asPlainObject(entry.config)?.providers)?.[DEEPSEEK_FIREWORKS_PROVIDER_ID]?.headers) ?? {};
      }
    }
    await writeFileAtomic(
      patchPath,
      serializeProfilePatch(patchDeepseekProfilePatchEntries(patch.entries, { modelId: target, headers })),
      { mode: 0o600 },
    );
    changed = true;
  }
  return changed;
}

/**
 * Re-bake credentials after login/rotation.
 * @param {{ settingsPath: string, credentialsPath: string, fireworksKey: string }} opts
 */
export async function refreshDeepseekGatewayKey({
  settingsPath,
  credentialsPath,
  fireworksKey,
}) {
  const key = fireworksKey?.trim();
  if (!key) {
    return false;
  }
  const settingsSnap = await readDeepseekSettingsIfExists(settingsPath);
  const effective = await deepseekEffectiveFireworksState(settingsPath, settingsSnap.settings);
  if (effective.provider !== "fireworks") {
    return false;
  }
  const credentialsSnap = await readDeepseekCredentialsIfExists(credentialsPath);
  const current = credentialsSnap.credentials[DEEPSEEK_API_KEY_ENV] ?? "";
  if (current === key) {
    return false;
  }
  await mkdir(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    credentialsPath,
    serializeYaml({
      ...credentialsSnap.credentials,
      [DEEPSEEK_API_KEY_ENV]: key,
    }),
    { mode: 0o600 },
  );
  return true;
}

/**
 * @param {{ existed: boolean, raw: string }} snapshot
 * @param {string} filePath
 * @param {number} [mode]
 */
async function restoreRawSnapshot(snapshot, filePath, mode = 0o600) {
  if (snapshot.existed) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(filePath, snapshot.raw, { mode });
    return;
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * @param {{
 *   settingsPath: string,
 *   credentialsPath: string,
 *   dataDir: string,
 *   wasEnabled?: boolean,
 * }} args
 * @returns {Promise<"restored" | "stripped" | "unchanged">}
 */
export async function disableDeepseekFireworks({
  settingsPath,
  credentialsPath,
  dataDir,
  wasEnabled = false,
}) {
  const backupPath = deepseekBackupPath(dataDir, settingsPath);
  const backup = await readJsonIfExists(backupPath);
  const settingsSnap = await readDeepseekSettingsIfExists(settingsPath);
  const hasBackup = backup.settingsSnapshot !== undefined;
  const patchSnapshots = asPlainObject(backup.profilePatchSnapshots) ?? {};
  const hasPatchBackup = Object.keys(patchSnapshots).length > 0;

  if (!wasEnabled && !hasBackup && !hasPatchBackup && deepseekProviderStatus(settingsSnap.settings) !== "fireworks") {
    return "unchanged";
  }

  if (backup.settingsPath !== undefined && backup.settingsPath !== path.resolve(settingsPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.settingsPath}, not ${settingsPath}; refusing to restore.`,
    );
  }

  if (hasBackup) {
    if (backup.settingsSnapshot) {
      await restoreRawSnapshot(backup.settingsSnapshot, settingsPath);
    }
    if (backup.credentialsSnapshot) {
      await restoreRawSnapshot(backup.credentialsSnapshot, credentialsPath);
    }
    await restoreProfilePatchSnapshots(patchSnapshots);
    await stripLeftoverProfilePatches(settingsPath, patchSnapshots);
    try {
      await unlink(backupPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    return "restored";
  }

  // Patch-only backup (in-place upgrade of an already-managed install): the
  // settings strip below still runs, but the patches restore from snapshot.
  let outcome = null;
  if (hasPatchBackup) {
    await restoreProfilePatchSnapshots(patchSnapshots);
    await stripLeftoverProfilePatches(settingsPath, patchSnapshots);
    try {
      await unlink(backupPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    outcome = "restored";
  }

  if (!settingsSnap.existed) {
    return outcome ?? "unchanged";
  }

  const nextRaw = serializeYaml(stripDeepseekFireworksSettings(settingsSnap.settings));
  if (nextRaw) {
    await writeFileAtomic(settingsPath, nextRaw, { mode: 0o600 });
  } else {
    await restoreRawSnapshot({ existed: false, raw: "" }, settingsPath);
  }

  const credentialsSnap = await readDeepseekCredentialsIfExists(credentialsPath);
  if (credentialsSnap.existed) {
    const nextCreds = { ...credentialsSnap.credentials };
    delete nextCreds[DEEPSEEK_API_KEY_ENV];
    const credRaw = serializeYaml(nextCreds);
    if (credRaw) {
      await writeFileAtomic(credentialsPath, credRaw, { mode: 0o600 });
    } else {
      await restoreRawSnapshot({ existed: false, raw: "" }, credentialsPath);
    }
  }

  return outcome ?? "stripped";
}

/**
 * Restore per-profile patch snapshots captured by enable.
 * @param {Record<string, { existed: boolean, raw: string }>} snapshots
 */
async function restoreProfilePatchSnapshots(snapshots) {
  for (const [patchPath, snapshot] of Object.entries(snapshots)) {
    if (!snapshot || typeof snapshot !== "object") {
      continue;
    }
    await restoreRawSnapshot(snapshot, patchPath);
  }
}

/**
 * Strip Nexus-owned entries from every profile patch that has no
 * snapshot — profiles dsh created or imported after `on`, whose fireworks
 * route would otherwise survive `off`.
 * @param {string} settingsPath
 * @param {Record<string, unknown>} snapshots
 */
async function stripLeftoverProfilePatches(settingsPath, snapshots) {
  const restored = new Set(Object.keys(snapshots).map((key) => path.resolve(key)));
  for (const patchPath of await deepseekPatchPaths(settingsPath)) {
    if (restored.has(path.resolve(patchPath))) {
      continue;
    }
    let patch;
    try {
      patch = await readDeepseekProfilePatch(patchPath);
    } catch {
      continue; // Unparseable user patch — leave it alone.
    }
    const { entries, changed } = stripDeepseekProfilePatchEntries(patch.entries);
    if (!changed) {
      continue;
    }
    await writeFileAtomic(patchPath, serializeProfilePatch(entries), { mode: 0o600 });
  }
}
