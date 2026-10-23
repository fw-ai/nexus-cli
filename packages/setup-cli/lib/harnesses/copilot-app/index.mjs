import {
  printHarnessConnected,
  printNote,
  printRestartHint,
} from "../../cli/messages.mjs";
import { printStructuredHarnessStatus } from "../../harness/status-display.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import { ensureHomeForHarness, copilotAppPathsFor } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { isHarnessEnabled } from "../../config/global-config.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import { loadRegisterableModels } from "../../fireworks/models.mjs";
import {
  COPILOT_FIREWORKS_BASE_URL,
  copilotDataDir,
  copilotProviderStatus,
  copilotResolveKey,
  disableCopilotFireworks,
  enableCopilotFireworks,
  ensureCopilotStopped,
  readCopilotState,
} from "./core.mjs";
import { copilotDataDbPath } from "./sqlite.mjs";

/** User-facing note: native Copilot models keep working alongside ours. */
const COPILOT_BYOK_NOTE =
  "Fireworks models appear in the model picker under \"Fireworks\". "
  + "Built-in Copilot models keep working too — pick either at any time.";

async function copilotResolveKeyForContext(ctx) {
  const { dbPath } = copilotAppPathsFor(ctx);
  return copilotResolveKey(dbPath);
}


export default defineHarnessProfile({
  id: HARNESS.COPILOT_APP,
  label: "Copilot app",
  resolveKey: copilotResolveKeyForContext,
  keyEnvRef: "${FIREWORKS_API_KEY}",
  getExistingHarnessKey: copilotResolveKeyForContext,
  paths: (ctx) => copilotAppPathsFor(ctx),
  // The BYOK provider row can't carry per-request headers, so a local
  // Anthropic BYOK key can't be forwarded — same constraint as Cursor.
  firerouter: {
    byok: "none",
    autoCatalog: true,
  },
  // The provider row carries a headersJson map, so attribution rides along with
  // the Authorization header.
  telemetryHeaders: true,
  enable: async ({ ctx, paths, effectiveKey, modelId, telemetryHeaders = {} }) => {
    // Register the preferred catalog; a TTL-cached snapshot serves offline. A
    // cold start with no network must fail the `on` rather than register from
    // an empty model list. When no catalog entries are available at all, treat
    // it as unavailable so a previous online run's registered models are kept.
    const { ids: extraModels, available: catalogAvailable } = await loadRegisterableModels({
      apiKey: effectiveKey,
    });
    await ensureCopilotStopped({ force: ctx.force });
    return enableCopilotFireworks({
      dbPath: paths.dbPath,
      dataDir: paths.dataDir,
      apiKey: effectiveKey,
      modelId,
      extraModels,
      extraHeaders: telemetryHeaders,
      catalogUnavailable: !catalogAvailable,
    });
  },
  printConnected: ({ result }) => {
    printHarnessConnected("Copilot app", { model: result.model });
    printNote(COPILOT_BYOK_NOTE);
  },
  restartHint: () => printRestartHint("Quit & reopen GitHub Copilot for the new models to appear."),

  // The key lives in the OS keychain via the app's own BYOK slot (no shell env
  // hook), and the app must be stopped before writing.
  envHookOff: false,
  prepareOff: (ctx) => ensureCopilotStopped({ force: ctx.force }),
  disable: async ({ paths }) => disableCopilotFireworks({ dbPath: paths.dbPath }),
  restartHintOff: () => printRestartHint("Quit & reopen GitHub Copilot for full effect."),
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.COPILOT_APP);
    const paths = copilotAppPathsFor(ctx);
    return copilotProviderStatus(paths.dbPath);
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.COPILOT_APP);
    const paths = copilotAppPathsFor(ctx);
    const { dbPath } = paths;
    const enabled = await isHarnessEnabled(ctx.home, HARNESS.COPILOT_APP);
    const { provider, apiKey, models } = await readCopilotState(dbPath);
    const provider_ = provider ? await copilotProviderStatus(dbPath) : "none";

    const payload = {
      harness: HARNESS.COPILOT_APP,
      enabled,
      provider: provider_,
      baseUrl: provider ? COPILOT_FIREWORKS_BASE_URL : null,
      providerName: provider ? provider.name : null,
      hasKey: Boolean(apiKey),
      keyType: provider_ === "none" ? "none" : "fireworks",
      registeredModels: models.map((model) => model.model_id),
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.COPILOT_APP, {
      provider: payload.provider,
      keyConfigured: payload.hasKey,
      authMode: "literal",
      model: models[0] ? models[0].model_id : null,
      registeredModels: payload.registeredModels,
      endpoint: payload.baseUrl,
      keySource: harnessStatusKeySource(HARNESS.COPILOT_APP, payload.provider, { whenFireworks: false }),
    });
  },
});
