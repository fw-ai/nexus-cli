import path from "node:path";

import {
  isAutoModelId,
  isAutoInstantModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { planCatalogRefresh } from "../../harness/catalog-refresh.mjs";
import {
  COPILOT_FIREWORKS_BASE_URL,
  copilotModelIds,
  describeCopilotAppModels,
  resolveCopilotModelId,
} from "../copilot-shared.mjs";
import {
  isFireworksKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import {
  findFireconnectProvider,
  listCopilotProviders,
  listCopilotProviderModels,
  newCopilotProviderId,
  removeFireconnectProvider,
  upsertFireconnectProvider,
} from "./sqlite.mjs";

/**
 * GitHub Copilot desktop app harness.
 *
 * The Copilot app (a Tauri app, not Electron) stores BYOK custom model
 * providers in `~/.copilot/data.db`:
 *
 *   model_providers (id, name, type, settings_json, account_id)
 *   provider_models (id, provider_id, model_id, wire_model, display_name, ...)
 *
 * The built-in `github_copilot:*` provider row is what the app itself ships —
 * we never touch it. Nexus adds one BYOK provider row (id prefix `fc-`)
 * pointing at the Fireworks OpenAI-compatible gateway, registers the model
 * catalog under it, and stores the API key in the macOS keychain under the
 * app's own BYOK secret slot (service `github-copilot-app`, account =
 * provider id). Native Copilot models keep working the whole time; the
 * Fireworks models appear alongside them in the model picker.
 *
 * That additivity makes `on`/`off` symmetric and trivially clean: `off`
 * removes exactly the `fc-` rows + keychain item. No snapshot/restore of
 * user config is needed (there is nothing to restore — we never modified it).
 */

export { ensureCopilotStopped } from "./sqlite.mjs";
export { COPILOT_FIREWORKS_BASE_URL } from "../copilot-shared.mjs";

export const COPILOT_DATA_RELATIVE_DIR = ".nexus/copilot-app";

/**
 * The harness is platform-independent. The app keeps its whole tree in
 * `~/.copilot` on every platform it ships for, and the key rides as a request
 * header on the provider row rather than in an OS keychain, so nothing here is
 * macOS-specific. `COPILOT_HOME` relocates the tree; see `copilotDataDbPath`.
 */

/**
 * The desktop harness's Nexus data dir. Separate from copilot-cli's so
 * the two harnesses' backups can never collide. Defaults to
 * `~/.nexus/copilot-app` unless overridden via `--data-dir`.
 * @param {string} home
 * @param {string} [dataDir]
 * @returns {string}
 */
export function copilotDataDir(home, dataDir = "") {
  return dataDir || path.join(home, COPILOT_DATA_RELATIVE_DIR);
}

/**
 * Read the current state of the fireconnect-owned BYOK provider (if any).
 * @param {string} dbPath
 * @returns {Promise<{ provider: object | null, apiKey: string, models: Array<{ model_id: string, display_name: string, wire_model: string }> }>}
 */
export async function readCopilotState(dbPath) {
  const provider = await findFireconnectProvider(dbPath);
  if (!provider) {
    return { provider: null, apiKey: "", models: [] };
  }
  const models = await listCopilotProviderModels(dbPath, provider.id);
  return { provider, apiKey: providerApiKey(provider), models };
}

/**
 * Extract the API key from a provider row's Authorization header.
 * Returns "" when the row carries no usable header.
 * @param {{ id: string, settings_json: string }} provider
 * @returns {string}
 */
export function providerApiKey(provider) {
  try {
    const settings = JSON.parse(provider.settings_json || "{}");
    const headers = JSON.parse(settings.headersJson || "{}");
    const auth = headers.Authorization ?? headers.authorization ?? "";
    const bearer = /^Bearer\s+(.+)$/i.exec(auth);
    return bearer ? bearer[1].trim() : "";
  } catch {
    return "";
  }
}

/**
 * "fireworks" when our BYOK provider row is present and points at the
 * Fireworks gateway (even when the key is unreadable — the row is what routes
 * model-picker traffic), else "none". Mirrors cursor's deliberate stance: a
 * half-finished teardown must still look active so `off` can repair it.
 * @param {string} dbPath
 * @returns {Promise<"fireworks" | "none">}
 */
export async function copilotProviderStatus(dbPath) {
  const provider = await findFireconnectProvider(dbPath);
  if (!provider) {
    return "none";
  }
  // A row under our fc- id prefix is ours — we never write another provider's
  // id — so its presence alone is the answer. The row is what routes
  // model-picker traffic, so this stays correct even when the key is
  // unreadable or the settings blob is mid-write.
  return "fireworks";
}

/**
 * Enable Fireworks routing for the Copilot app: upsert the `fc-` BYOK provider
 * row with the Fireworks base URL + keychain secret, and register the resolved
 * model plus the catalog under it.
 *
 * @param {{ dbPath: string, apiKey: string, modelId?: string, extraModels?: string[], extraHeaders?: Record<string,string>, catalogUnavailable?: boolean }} opts
 * @returns {Promise<{ model: string, modelsAdded: string[], providerId: string }>}
 */
export async function enableCopilotFireworks({
  dbPath,
  apiKey,
  modelId,
  extraModels = [],
  extraHeaders = {},
  catalogUnavailable = false,
}) {
  if (!apiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const resolvedModel = shortFireworksModelRef(resolveCopilotModelId(modelId?.trim()));

  // Re-`on` reuses the same provider id so the app's stored sessions keep
  // resolving; only the registered models are replaced.
  const existing = await findFireconnectProvider(dbPath);
  const providerId = existing ? existing.id : newCopilotProviderId();

  const current = existing
    ? (await listCopilotProviderModels(dbPath, providerId)).map((model) => model.model_id)
    : [];
  const catalogModels = copilotModelIds(extraModels);
  let toRegister;
  if (!existing) {
    // Shared fresh-install policy (see lib/harness/catalog-refresh.mjs).
    toRegister = copilotModelIds([resolvedModel, ...extraModels]);
  } else if (modelId) {
    toRegister = [...new Set([...current, resolvedModel])];
  } else if (catalogUnavailable) {
    toRegister = current;
  } else {
    // Shared catalog-refresh policy: prune delisted ids, add newly served
    // ones. describeCopilotAppModels rebuilds every row's metadata below, so
    // kept rows are refreshed automatically.
    const plan = planCatalogRefresh({
      currentIds: current,
      freshIds: catalogModels,
      keepUnserved: (id) => isAutoModelId(id) && !isAutoInstantModelId(id),
    });
    toRegister = [...plan.kept, ...plan.added];
  }
  const models = describeCopilotAppModels(toRegister);

  await upsertFireconnectProvider(dbPath, { providerId, apiKey, models, extraHeaders });

  return {
    model: resolvedModel,
    modelsAdded: toRegister,
    providerId,
  };
}

/**
 * Disable Fireworks routing: remove exactly the fireconnect-owned provider
 * rows and their registered models. User-created BYOK providers and the
 * built-in `github_copilot` provider are never touched.
 *
 * @param {{ dbPath: string }} opts
 * @returns {Promise<"restored" | "none">}
 */
export async function disableCopilotFireworks({ dbPath }) {
  const providers = await findFireconnectProviders(dbPath);
  for (const provider of providers) {
    await removeFireconnectProvider(dbPath, provider.id);
  }
  if (providers.length === 0) {
    return "none";
  }
  return "restored";
}

/** All fireconnect-owned provider rows (normally zero or one). */
async function findFireconnectProviders(dbPath) {
  const all = await listCopilotProviders(dbPath);
  return all.filter((provider) => provider.id.startsWith("fc-"));
}


/**
 * Read the stored Fireworks key for status/key-reuse. Returns "" when absent
 * or not Fireworks-shaped.
 * @param {string} dbPath
 * @returns {Promise<string>}
 */
export async function copilotResolveKey(dbPath) {
  const { provider, apiKey } = await readCopilotState(dbPath);
  if (!provider) {
    return "";
  }
  return isFireworksKey(apiKey) ? apiKey.trim() : "";
}
