import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { COPILOT_FIREWORKS_BASE_URL } from "../copilot-shared.mjs";
import { readJsonIfExists } from "../../io/json.mjs";

/**
 * GitHub Copilot **CLI** (`@github/copilot`) BYOK configuration.
 *
 * The CLI and the desktop app are separate products that share only the
 * `~/.copilot` directory. Their BYOK registries do not overlap:
 *
 *   desktop app -> data.db (model_providers / provider_models)  [core.mjs]
 *   CLI         -> providers.json                               [this file]
 *
 * The CLI never reads data.db (it only `existsSync`es it to suppress an
 * "install the desktop app" nudge), and the desktop app ignores
 * providers.json entirely — verified by writing a full one and watching the
 * app's picker stay empty. So `copilot on` writes both to cover either tool,
 * and neither write can disturb the other.
 *
 * Two things the CLI format expresses that the app's schema cannot: per-model
 * `capabilities.supports.vision`, and a context-window limit. Both come from
 * the serverless catalog, so nothing is pinned here.
 */

/** Provider name; also the qualifier in every selection id. */
export const COPILOT_CLI_PROVIDER_NAME = "fireworks";

/** The CLI harness's Nexus data dir — separate from copilot-app's so the two backups can't collide. */
export const COPILOT_CLI_DATA_RELATIVE_DIR = ".nexus/copilot-cli";

/**
 * @param {string} home
 * @param {string} [dataDir]
 * @returns {string}
 */
export function copilotCliDataDir(home, dataDir = "") {
  return dataDir || path.join(home, COPILOT_CLI_DATA_RELATIVE_DIR);
}

/**
 * Resolve `providers.json`. `COPILOT_PROVIDERS_CONFIG` points at the file
 * directly; otherwise it lives in the config dir, which `COPILOT_HOME`
 * relocates wholesale. Same layout on every platform.
 * @param {{ home?: string, providersPath?: string }} opts
 * @returns {string}
 */
export function copilotProvidersPath({ home = "", providersPath = "" } = {}) {
  if (providersPath) {
    return path.resolve(providersPath);
  }
  const explicit = process.env.COPILOT_PROVIDERS_CONFIG?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const configDir = process.env.COPILOT_HOME?.trim();
  if (configDir) {
    return path.join(path.resolve(configDir), "providers.json");
  }
  const baseHome = home || process.env.HOME || process.env.USERPROFILE || "";
  return path.join(baseHome, ".copilot", "providers.json");
}

/**
 * The CLI addresses BYOK models by a **provider-qualified** id. A bare id is
 * rejected ("Model … is not available") and silently falls back to another
 * model, so every selection must carry the prefix.
 * @param {string} modelId
 * @returns {string}
 */
export function copilotCliSelectionId(modelId) {
  return `${COPILOT_CLI_PROVIDER_NAME}/${modelId}`;
}

/** Resolve a provider-qualified Copilot CLI selection back to its model id. */
export function copilotCliModelIdFromSelection(selectionId) {
  const prefix = `${COPILOT_CLI_PROVIDER_NAME}/`;
  return typeof selectionId === "string" && selectionId.startsWith(prefix)
    ? selectionId.slice(prefix.length)
    : "";
}

/** Backups are keyed by file path so two configs can't restore onto each other. */
export function copilotProvidersBackupPath(dataDir, providersPath) {
  const key = createHash("sha256").update(path.resolve(providersPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `providers-backup.${key}.json`);
}

/**
 * Resolve the CLI's user settings file, which sits beside providers.json in
 * the config dir (`COPILOT_HOME` relocates both).
 * @param {{ home?: string, settingsPath?: string }} opts
 * @returns {string}
 */
export function copilotSettingsPath({ home = "", settingsPath = "" } = {}) {
  if (settingsPath) {
    return path.resolve(settingsPath);
  }
  const configDir = process.env.COPILOT_HOME?.trim();
  if (configDir) {
    return path.join(path.resolve(configDir), "settings.json");
  }
  const baseHome = home || process.env.HOME || process.env.USERPROFILE || "";
  return path.join(baseHome, ".copilot", "settings.json");
}

/** Backup for the settings file, keyed the same way. */
export function copilotSettingsBackupPath(dataDir, settingsPath) {
  const key = createHash("sha256").update(path.resolve(settingsPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `settings-backup.${key}.json`);
}

/**
 * Raw-text snapshot (not re-serialized JSON) so `off` restores the user's
 * file byte-for-byte, preserving their formatting and key order.
 * @param {string} filePath
 * @returns {Promise<{ existed: boolean, raw: string }>}
 */
async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { existed: false, raw: "" };
    }
    throw error;
  }
}

function parseJsonOrNull(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Whether providers.json already carries Nexus's provider or models. */
function hasManagedProviders(raw) {
  const config = raw.trim() ? parseJsonOrNull(raw) : null;
  return Boolean(config)
    && ((Array.isArray(config.providers) && config.providers.some((p) => p?.name === COPILOT_CLI_PROVIDER_NAME))
      || (Array.isArray(config.models) && config.models.some((m) => m?.provider === COPILOT_CLI_PROVIDER_NAME)));
}

/** Whether settings.json already selects one of Nexus's models. */
function hasManagedSelection(raw) {
  const settings = raw.trim() ? parseJsonOrNull(raw) : null;
  return typeof settings?.model === "string" && settings.model.startsWith(`${COPILOT_CLI_PROVIDER_NAME}/`);
}

/**
 * Build the `models[]` entries for the CLI.
 * @param {Array<{ id: string, displayName: string, maxPromptTokens?: number|null, maxOutputTokens?: number|null, vision?: boolean }>} models
 */
export function buildCliModels(models) {
  return models.map((model) => ({
    id: model.id,
    provider: COPILOT_CLI_PROVIDER_NAME,
    wireModel: model.id,
    name: model.displayName,
    ...(model.maxPromptTokens ? { maxPromptTokens: model.maxPromptTokens } : {}),
    ...(model.maxPromptTokens ? { maxContextWindowTokens: model.maxPromptTokens } : {}),
    ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    // `supports` is camelCase (the nested `limits` keys are snake_case).
    // reasoningEffort is an on/off toggle here — the CLI derives the actual
    // effort menu from catalog lookup — and every level we publish for the
    // desktop app was verified against the gateway.
    //
    // vision comes from the catalog (see the note at the top of this file).
    capabilities: {
      supports: {
        reasoningEffort: true,
        ...(model.vision ? { vision: true } : {}),
      },
      ...(model.vision
        ? {
          limits: {
            vision: {
              supported_media_types: ["image/jpeg", "image/png", "image/webp"],
              max_prompt_images: 5,
              max_prompt_image_size: 3145728,
            },
          },
        }
        : {}),
    },
  }));
}

/**
 * Write the Fireworks provider + models into `providers.json`, preserving any
 * providers/models the user configured themselves.
 *
 * A snapshot is taken only on the first `on` (never overwriting an existing
 * backup), so `off` can restore the original byte-for-byte. A file that
 * already carries Nexus's provider isn't the user's original (the backup was
 * lost); it isn't snapshotted, and `off` strips Nexus's entries instead.
 *
 * @param {{ providersPath: string, dataDir: string, apiKey: string, models: object[], extraHeaders?: Record<string,string> }} opts
 * @returns {Promise<{ providersPath: string, modelsAdded: string[] }>}
 */
export async function enableCopilotCli({
  providersPath,
  dataDir,
  apiKey,
  models,
  extraHeaders = {},
}) {
  const { existed, raw } = await readRawIfExists(providersPath);

  const backupPath = copilotProvidersBackupPath(dataDir, providersPath);
  const hasBackup = Object.keys(await readJsonIfExists(backupPath)).length > 0;
  if (!hasBackup && !hasManagedProviders(raw)) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(backupPath, `${JSON.stringify({ providersPath: path.resolve(providersPath), snapshot: { existed, raw } }, null, 2)}\n`);
    await chmod(backupPath, 0o600);
  }

  let config = {};
  if (existed && raw.trim()) {
    try {
      config = JSON.parse(raw);
    } catch {
      // A malformed file would make the CLI hard-error on load; replacing it
      // is the only way forward, and the snapshot above preserves it.
      config = {};
    }
  }

  const otherProviders = (Array.isArray(config.providers) ? config.providers : [])
    .filter((provider) => provider?.name !== COPILOT_CLI_PROVIDER_NAME);
  const otherModels = (Array.isArray(config.models) ? config.models : [])
    .filter((model) => model?.provider !== COPILOT_CLI_PROVIDER_NAME);

  const next = {
    ...config,
    providers: [
      ...otherProviders,
      {
        name: COPILOT_CLI_PROVIDER_NAME,
        type: "openai",
        wireApi: "completions",
        baseUrl: COPILOT_FIREWORKS_BASE_URL,
        apiKey,
        ...(Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {}),
      },
    ],
    models: [...otherModels, ...buildCliModels(models)],
  };

  await mkdir(path.dirname(providersPath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(providersPath, `${JSON.stringify(next, null, 2)}\n`);
  // The file holds the API key in cleartext, so keep it owner-only.
  await chmod(providersPath, 0o600);

  return { providersPath, modelsAdded: models.map((model) => model.id) };
}

/**
 * Back out the CLI config: restore the pre-`on` file byte-for-byte when a
 * snapshot exists, otherwise strip only the entries Nexus owns.
 *
 * @param {{ providersPath: string, dataDir: string }} opts
 * @returns {Promise<"restored" | "stripped" | "none">}
 */
export async function disableCopilotCli({ providersPath, dataDir }) {
  const backupPath = copilotProvidersBackupPath(dataDir, providersPath);
  const backup = await readJsonIfExists(backupPath);

  if (backup.snapshot !== undefined) {
    if (backup.providersPath !== undefined && backup.providersPath !== path.resolve(providersPath)) {
      throw new Error(
        `Copilot CLI backup was taken for ${backup.providersPath}, not ${providersPath}; refusing to restore.`,
      );
    }
    const { existed, raw } = backup.snapshot;
    if (existed) {
      await writeFileAtomic(providersPath, raw);
      await chmod(providersPath, 0o600).catch(() => {});
    } else {
      // We created the file; remove it rather than leaving an empty shell.
      await unlink(providersPath).catch(() => {});
    }
    await unlink(backupPath).catch(() => {});
    return "restored";
  }

  // No snapshot (e.g. a backup removed by hand): strip only our own entries.
  const { existed, raw } = await readRawIfExists(providersPath);
  if (!existed || !raw.trim()) {
    return "none";
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return "none";
  }
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const models = Array.isArray(config.models) ? config.models : [];
  const ours = providers.some((provider) => provider?.name === COPILOT_CLI_PROVIDER_NAME)
    || models.some((model) => model?.provider === COPILOT_CLI_PROVIDER_NAME);
  if (!ours) {
    return "none";
  }
  const next = {
    ...config,
    providers: providers.filter((provider) => provider?.name !== COPILOT_CLI_PROVIDER_NAME),
    models: models.filter((model) => model?.provider !== COPILOT_CLI_PROVIDER_NAME),
  };
  await writeFileAtomic(providersPath, `${JSON.stringify(next, null, 2)}\n`);
  await chmod(providersPath, 0o600).catch(() => {});
  return "stripped";
}

/**
 * Select a model for the CLI by writing `model` into its user settings.
 *
 * Without this the CLI errors out — a BYOK provider has no default, so a bare
 * `copilot -p ...` fails with "No supported model available" (the runtime logs
 * "Custom provider requires an explicit model"). Registering models in
 * providers.json is not enough; one has to be chosen.
 *
 * The value must be the provider-qualified id. Other settings are preserved,
 * and the pre-`on` file is snapshotted for byte-for-byte restore.
 *
 * @param {{ settingsPath: string, dataDir: string, selectionId: string }} opts
 * @returns {Promise<void>}
 */
export async function selectCopilotCliModel({ settingsPath, dataDir, selectionId }) {
  const { existed, raw } = await readRawIfExists(settingsPath);

  const backupPath = copilotSettingsBackupPath(dataDir, settingsPath);
  const hasBackup = Object.keys(await readJsonIfExists(backupPath)).length > 0;
  // Same rule as providers.json: never snapshot Nexus's own selection.
  if (!hasBackup && !hasManagedSelection(raw)) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(backupPath, `${JSON.stringify({ settingsPath: path.resolve(settingsPath), snapshot: { existed, raw } }, null, 2)}\n`);
    await chmod(backupPath, 0o600).catch(() => {});
  }

  let settings = {};
  if (existed && raw.trim()) {
    try {
      settings = JSON.parse(raw);
    } catch {
      settings = {};
    }
  }
  settings.model = selectionId;

  await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Restore the CLI settings file saved by {@link selectCopilotCliModel}.
 * @param {{ settingsPath: string, dataDir: string }} opts
 * @returns {Promise<"restored" | "stripped" | "none">}
 */
export async function deselectCopilotCliModel({ settingsPath, dataDir }) {
  const backupPath = copilotSettingsBackupPath(dataDir, settingsPath);
  const backup = await readJsonIfExists(backupPath);

  if (backup.snapshot !== undefined) {
    if (backup.settingsPath !== undefined && backup.settingsPath !== path.resolve(settingsPath)) {
      throw new Error(
        `Copilot settings backup was taken for ${backup.settingsPath}, not ${settingsPath}; refusing to restore.`,
      );
    }
    const { existed, raw } = backup.snapshot;
    if (existed) {
      await writeFileAtomic(settingsPath, raw);
    } else {
      await unlink(settingsPath).catch(() => {});
    }
    await unlink(backupPath).catch(() => {});
    return "restored";
  }

  // No snapshot: drop only our own selection, leaving other settings intact.
  const { existed, raw } = await readRawIfExists(settingsPath);
  if (!existed || !raw.trim()) {
    return "none";
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    return "none";
  }
  if (typeof settings.model !== "string" || !settings.model.startsWith(`${COPILOT_CLI_PROVIDER_NAME}/`)) {
    return "none";
  }
  delete settings.model;
  await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return "stripped";
}

/**
 * Rebake the Fireworks API key in `providers.json` after a login/upgrade
 * rotates it — the CLI path bakes a literal key, exactly the case
 * `syncBakedKeysAfterStore` exists for.
 * @param {{ providersPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>} true when the stored key was replaced
 */
export async function refreshCopilotCliGatewayKey({ providersPath, fireworksKey }) {
  const { existed, raw } = await readRawIfExists(providersPath);
  if (!existed || !raw.trim()) {
    return false;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return false;
  }
  const provider = (Array.isArray(config.providers) ? config.providers : [])
    .find((entry) => entry?.name === COPILOT_CLI_PROVIDER_NAME);
  if (!provider || typeof provider.apiKey !== "string") {
    return false;
  }
  if (provider.apiKey === fireworksKey) {
    return false;
  }
  provider.apiKey = fireworksKey;
  await writeFileAtomic(providersPath, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/**
 * Read the CLI-side state for `status`.
 * @param {string} providersPath
 * @returns {Promise<{ configured: boolean, apiKey: string, models: string[] }>}
 */
export async function readCopilotCliState(providersPath, settingsPath = "") {
  const empty = { configured: false, apiKey: "", models: [], selectedModel: null };
  const { existed, raw } = await readRawIfExists(providersPath);
  if (!existed || !raw.trim()) {
    return empty;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return empty;
  }
  const provider = (Array.isArray(config.providers) ? config.providers : [])
    .find((entry) => entry?.name === COPILOT_CLI_PROVIDER_NAME);
  const models = (Array.isArray(config.models) ? config.models : [])
    .filter((model) => model?.provider === COPILOT_CLI_PROVIDER_NAME)
    .map((model) => model.id);
  // The selection lives in settings.json. Read the same file the caller
  // wrote to — a --providers-path override must not send the reader to a
  // different directory than the writer used.
  let selectedModel = null;
  try {
    const settings = await readJsonIfExists(settingsPath);
    if (typeof settings.model === "string" && settings.model.startsWith(`${COPILOT_CLI_PROVIDER_NAME}/`)) {
      selectedModel = settings.model;
    }
  } catch {
    // Unreadable settings just means "no selection to report".
  }

  return {
    configured: Boolean(provider),
    apiKey: typeof provider?.apiKey === "string" ? provider.apiKey : "",
    models,
    selectedModel,
  };
}
