import {
  printHarnessConnected,
  printNote,
  printRestartHint,
} from "../../cli/messages.mjs";
import { printStructuredHarnessStatus } from "../../harness/status-display.mjs";
import { planCatalogRefresh } from "../../harness/catalog-refresh.mjs";
import { isFireworksKey } from "../../keys/key-type.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import { ensureHomeForHarness, copilotCliPathsFor as copilotCliPathsForShared } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { isHarnessEnabled } from "../../config/global-config.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import { loadRegisterableModels } from "../../fireworks/models.mjs";
import {
  dropRetiredModelId,
  isAutoModelId,
  isAutoInstantModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import {
  COPILOT_FIREWORKS_BASE_URL,
  copilotModelIds,
  describeCopilotModels,
  resolveCopilotModelId,
} from "../copilot-shared.mjs";
import {
  copilotCliModelIdFromSelection,
  copilotCliSelectionId,
  copilotProvidersPath,
  copilotSettingsPath,
  deselectCopilotCliModel,
  disableCopilotCli,
  enableCopilotCli,
  readCopilotCliProviderHeaders,
  readCopilotCliState,
  selectCopilotCliModel,
} from "./config.mjs";
import { byokEnvFromHeaders } from "../../firerouter/core.mjs";

/**
 * GitHub Copilot **CLI** harness (`@github/copilot`, the `copilot` command).
 *
 * Separate from `copilot-app` because the two products share no config: this
 * one reads `~/.copilot/providers.json` and never looks at the desktop app's
 * data.db. See ./config.mjs for the format and the snapshot/restore rules.
 */


async function copilotCliResolveKey(ctx) {
  const { providersPath } = copilotCliPathsForShared(ctx);
  const { apiKey } = await readCopilotCliState(providersPath);
  // Only reuse a key that is actually Fireworks-shaped — a stale or hand-
  // edited entry is not a credential, it just 401s.
  return isFireworksKey(apiKey) ? apiKey.trim() : "";
}

export default defineHarnessProfile({
  id: HARNESS.COPILOT_CLI,
  label: "Copilot CLI",
  resolveKey: copilotCliResolveKey,
  keyEnvRef: "${FIREWORKS_API_KEY}",
  getExistingHarnessKey: copilotCliResolveKey,
  paths: (ctx) => copilotCliPathsForShared(ctx),
  // providers.json carries a per-request header map on the provider, so
  // provider keys for Nexus Auto ride there next to telemetry.
  firerouter: {
    byok: "value",
    autoCatalog: true,
  },
  telemetryHeaders: true,
  readByokEnv: async (_ctx, paths) => byokEnvFromHeaders(
    await readCopilotCliProviderHeaders(paths.providersPath),
  ),
  enable: async ({ ctx, paths, effectiveKey, modelId, byokHeaders = {}, telemetryHeaders = {} }) => {
    const { ids: extraModels, available: catalogAvailable } = await loadRegisterableModels({
      apiKey: effectiveKey,
    });
    const existing = await readCopilotCliState(paths.providersPath, paths.settingsPath);
    const existingSelection = copilotCliModelIdFromSelection(existing.selectedModel);
    // A plain re-`on` drops a carried-over FireRouter selection to `auto`;
    // (a FireRouter `--model` is rejected at admission, so `modelId` is never one from the CLI).
    const requestedModel = modelId?.trim() || dropRetiredModelId(existingSelection);
    const resolvedModel = shortFireworksModelRef(resolveCopilotModelId(requestedModel));
    const initialized = await isHarnessEnabled(ctx.home, HARNESS.COPILOT_CLI);
    const catalogModels = copilotModelIds(extraModels);
    let toRegister;
    if (!initialized) {
      // Shared fresh-install policy (see lib/harness/catalog-refresh.mjs).
      toRegister = copilotModelIds([resolvedModel, ...extraModels]);
    } else if (modelId) {
      toRegister = [...new Set([...existing.models, resolvedModel])];
    } else if (catalogAvailable) {
      const plan = planCatalogRefresh({
        // Include the saved selection even if providers.json was edited or
        // partially lost; the selected model must remain registered.
        currentIds: [...existing.models, existingSelection].filter(Boolean),
        freshIds: catalogModels,
        keepUnserved: (id) => (
          id === resolvedModel
          || (isAutoModelId(id) && !isAutoInstantModelId(id))
        ),
      });
      toRegister = [...plan.kept, ...plan.added];
    } else {
      toRegister = existing.models;
    }

    await enableCopilotCli({
      providersPath: paths.providersPath,
      dataDir: paths.dataDir,
      apiKey: effectiveKey,
      models: describeCopilotModels(toRegister),
      extraHeaders: { ...telemetryHeaders, ...byokHeaders },
    });
    // A BYOK provider has no default model, so without a selection the CLI
    // refuses to start ("No supported model available").
    await selectCopilotCliModel({
      settingsPath: paths.settingsPath,
      dataDir: paths.dataDir,
      selectionId: copilotCliSelectionId(resolvedModel),
    });

    return {
      model: resolvedModel,
      modelsAdded: toRegister,
      selectionId: copilotCliSelectionId(resolvedModel),
    };
  },
  printConnected: ({ result }) => {
    printHarnessConnected("Copilot CLI", { model: result.model });
    printNote(
      `Selected as \`${result.selectionId}\` — the CLI addresses BYOK models by their `
        + "provider-qualified id. Switch with `copilot --model fireworks/<id>` or `/model`.",
    );
  },
  restartHint: () => printRestartHint("Start a new `copilot` session to pick up the change."),

  // A plain config file: no shell env hook, and no app to quit.
  envHookOff: false,
  disable: async ({ paths }) => {
    const providers = await disableCopilotCli({
      providersPath: paths.providersPath,
      dataDir: paths.dataDir,
    });
    const selection = await deselectCopilotCliModel({
      settingsPath: paths.settingsPath,
      dataDir: paths.dataDir,
    });
    return providers === "none" && selection === "none" ? "none" : "restored";
  },

  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.COPILOT_CLI);
    const { providersPath } = copilotCliPathsForShared(ctx);
    return (await readCopilotCliState(providersPath)).configured ? "fireworks" : "none";
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.COPILOT_CLI);
    const paths = copilotCliPathsForShared(ctx);
    const enabled = await isHarnessEnabled(ctx.home, HARNESS.COPILOT_CLI);
    const state = await readCopilotCliState(paths.providersPath, paths.settingsPath);
    const provider = state.configured ? "fireworks" : "none";

    const payload = {
      harness: HARNESS.COPILOT_CLI,
      enabled,
      provider,
      baseUrl: state.configured ? COPILOT_FIREWORKS_BASE_URL : null,
      providersPath: paths.providersPath,
      hasKey: Boolean(state.apiKey),
      keyType: provider === "none" ? "none" : "fireworks",
      selectedModel: state.selectedModel,
      registeredModels: state.models,
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.COPILOT_CLI, {
      provider: payload.provider,
      keyConfigured: payload.hasKey,
      authMode: "literal",
      model: payload.selectedModel,
      registeredModels: payload.registeredModels,
      endpoint: payload.baseUrl,
      keySource: harnessStatusKeySource(HARNESS.COPILOT_CLI, payload.provider, { whenFireworks: false }),
    });
  },
});
