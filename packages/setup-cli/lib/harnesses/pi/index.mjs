import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  printPiRestartHint,
} from "../../cli/messages.mjs";
import process from "node:process";
import { defaultMainModel, shortFireworksModelRef } from "../../fireworks/model-id.mjs";
import {
  PI_API_KEY_ENV_REF,
  PI_AZURE_PROVIDER,
  disablePiFireworks,
  enablePiAzure,
  enablePiFireworks,
  piAuthKeyMode,
  piAzureAuthKeyMode,
  piAzureCurrentModelId,
  piNexusProviderStatus,
  piProviderStatus,
  piStoredByokHeaders,
  readJsonFile,
  resolvePiApiKeyValue,
  resolvePiAzureApiKeyValue,
} from "./core.mjs";
import {
  byokEnvFromHeaders,
} from "../../firerouter/core.mjs";
import {
  loadRegisterableModels,
} from "../../fireworks/models.mjs";
import { isFireworksKey } from "../../keys/key-type.mjs";
import { DEFAULT_AZURE_MODEL } from "../../fireworks/azure-core.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  ensureHomeForHarness,
  piPathsFor,
} from "../../harness/context.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";

function piStoredApiKeyRef(auth) {
  return auth.fireworks?.key ?? "";
}

function piStoredAzureApiKeyRef(modelsConfig) {
  return modelsConfig.providers?.[PI_AZURE_PROVIDER]?.apiKey ?? "";
}

function piAzureBaseUrl(modelsConfig) {
  return modelsConfig.providers?.[PI_AZURE_PROVIDER]?.baseUrl ?? null;
}

/**
 * Harness-local Fireworks key for Pi: the key stored in auth.json
 * (resolving the $FIREWORKS_API_KEY reference). Returns "" when none.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function piResolveKey(ctx) {
  const { authPath } = piPathsFor(ctx);
  const auth = await readJsonFile(authPath);
  const key = resolvePiApiKeyValue(piStoredApiKeyRef(auth));
  return isFireworksKey(key) ? key.trim() : "";
}

export default defineHarnessProfile({
  id: HARNESS.PI,
  label: "Pi",
  resolveKey: piResolveKey,
  paths: (ctx) => piPathsFor(ctx),
  keyEnvRef: PI_API_KEY_ENV_REF,
  firerouter: {
    byok: "value",
    autoCatalog: true,
  },
  telemetryHeaders: true,
  readByokEnv: async (_ctx, paths) => byokEnvFromHeaders(
    piStoredByokHeaders(await readJsonFile(paths.modelsPath)),
  ),
  azure: {
    read: async (_ctx, paths) => {
      const settings = await readJsonFile(paths.settingsPath);
      const modelsConfig = await readJsonFile(paths.modelsPath);
      return {
        active: piProviderStatus(settings) === "azure",
        storedKey: piStoredAzureApiKeyRef(modelsConfig),
        storedBaseUrl: piAzureBaseUrl(modelsConfig) ?? "",
      };
    },
    enable: ({ ctx, paths, apiKey, apiKeyFromFlag, baseUrl }) => enablePiAzure({
      settingsPath: paths.settingsPath,
      authPath: paths.authPath,
      modelsPath: paths.modelsPath,
      dataDir: paths.dataDir,
      home: ctx.home,
      apiKey,
      apiKeyFromFlag,
      baseUrl,
      modelId: ctx.main,
    }),
    restart: () => printPiRestartHint(),
  },
  getExistingHarnessKey: async (_ctx, paths) => {
    const auth = await readJsonFile(paths.authPath);
    return piStoredApiKeyRef(auth);
  },
  enable: async ({
    ctx,
    paths,
    apiKeyRef,
    effectiveKey,
    modelId,
    byokHeaders,
    telemetryHeaders,
  }) => {
    // Register the preferred catalog; firerouter registers only when explicitly requested.
    // A TTL-cached snapshot serves offline fine; only a cold start with no
    // network throws here, and that must fail the `on` rather than register a
    // model list that was never fetched.
    const { ids: catalogModelIds } = await loadRegisterableModels({
      apiKey: effectiveKey,
    });
    return enablePiFireworks({
      ...paths,
      home: ctx.home,
      apiKey: apiKeyRef,
      effectiveApiKey: effectiveKey,
      modelId,
      byokHeaders,
      telemetryHeaders,
      catalogModelIds,
    });
  },
  envHookOn: (ctx) => finishEnvHarnessOn(ctx.home, { harnessId: "pi" }),
  restartHint: () => printPiRestartHint(),

  disable: async ({ ctx, paths }) => {
    const { changed } = await disablePiFireworks({ ...paths, home: ctx.home });
    return changed ? "restored" : "unchanged";
  },
  restartHintOff: (outcome) => {
    if (outcome !== "unchanged") {
      printPiRestartHint();
    }
  },
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    return piNexusProviderStatus({ ...piPathsFor(ctx), home: ctx.home });
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    const { settingsPath, authPath, modelsPath } = piPathsFor(ctx);
    const settings = await readJsonFile(settingsPath);
    const modelsConfig = await readJsonFile(modelsPath);
    const provider = await piNexusProviderStatus({ settingsPath, authPath, home: ctx.home });

    if (provider === "azure") {
      const storedAzure = piStoredAzureApiKeyRef(modelsConfig);
      const payload = {
        harness: HARNESS.PI,
        provider,
        baseUrl: piAzureBaseUrl(modelsConfig),
        hasAuthToken: Boolean(resolvePiAzureApiKeyValue(storedAzure)),
        defaults: { main: DEFAULT_AZURE_MODEL },
        current: { main: piAzureCurrentModelId(settings) },
        defaultProvider: settings.defaultProvider ?? null,
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printStructuredHarnessStatus(HARNESS.PI, {
        provider: payload.provider,
        keyConfigured: payload.hasAuthToken,
        authMode: piAzureAuthKeyMode(storedAzure),
        model: payload.current.main,
        endpoint: payload.baseUrl,
      });
      return;
    }

    const auth = await readJsonFile(authPath);
    const authKey = piStoredApiKeyRef(auth);
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel : null;
    const currentModel = provider === "fireworks" && model
      ? shortFireworksModelRef(model)
      : null;
    const payload = {
      harness: HARNESS.PI,
      provider,
      hasAuthToken: Boolean(authKey || process.env.FIREWORKS_API_KEY),
      apiKeyMode: piAuthKeyMode(authKey),
      defaults: { main: defaultMainModel() },
      current: { main: currentModel },
      defaultProvider: settings.defaultProvider ?? null,
      model,
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.PI, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: payload.apiKeyMode,
      model: payload.current.main,
      keySource: harnessStatusKeySource(HARNESS.PI, provider),
    });
  },

});
