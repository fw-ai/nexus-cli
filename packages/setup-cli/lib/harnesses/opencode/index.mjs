import { printOpenCodeRestartHint } from "../../cli/messages.mjs";
import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import process from "node:process";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import { readJsonIfExists } from "../../io/json.mjs";
import {
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_AZURE_PROVIDER_ID,
  OPENCODE_FIREWORKS_PROVIDER_ID,
  disableOpencodeFireworks,
  effectiveOpencodeApiKey,
  enableOpencodeAzure,
  enableOpencodeFireworks,
  opencodeCurrentModelId,
  opencodeAuthKeyMode,
  opencodeProviderStatus,
} from "./core.mjs";
import { byokEnvFromHeaders } from "../../firerouter/core.mjs";
import {
  DEFAULT_AZURE_MODEL,
  effectiveAzureApiKey,
} from "../../fireworks/azure-core.mjs";
import {
  loadRegisterableModels,
} from "../../fireworks/models.mjs";
import { isFireworksKey } from "../../keys/key-type.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  ensureHomeForHarness,
  opencodePathsFor,
} from "../../harness/context.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";

function opencodeStoredApiKeyRef(config) {
  return config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.options?.apiKey
    ?? config.provider?.fireworks?.options?.apiKey
    ?? "";
}

function opencodeStoredByokHeaders(config) {
  return config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.options?.headers ?? {};
}
/**
 * Harness-local Fireworks key for OpenCode: the key stored in opencode.json
 * (resolving the {env:FIREWORKS_API_KEY} reference). Returns "" when none.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function opencodeResolveKey(ctx) {
  const { configPath } = opencodePathsFor(ctx);
  const config = await readJsonIfExists(configPath);
  const key = effectiveOpencodeApiKey(opencodeStoredApiKeyRef(config));
  return isFireworksKey(key) ? key.trim() : "";
}

function opencodeAzureStoredApiKeyRef(config) {
  return config.provider?.[OPENCODE_AZURE_PROVIDER_ID]?.options?.apiKey ?? "";
}

function opencodeAzureStoredBaseUrl(config) {
  return config.provider?.[OPENCODE_AZURE_PROVIDER_ID]?.options?.baseURL ?? "";
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {{ baseUrl: string, apiKey: string }} configured
 */
export default defineHarnessProfile({
  id: HARNESS.OPENCODE,
  label: "OpenCode",
  resolveKey: opencodeResolveKey,
  paths: (ctx) => opencodePathsFor(ctx),
  keyEnvRef: OPENCODE_API_KEY_ENV_REF,
  firerouter: {
    byok: "value",
    autoCatalog: true,
  },
  telemetryHeaders: true,
  readByokEnv: async (_ctx, paths) => byokEnvFromHeaders(
    opencodeStoredByokHeaders(await readJsonIfExists(paths.configPath)),
  ),
  azure: {
    read: async (_ctx, { configPath }) => {
      const config = await readJsonIfExists(configPath);
      return {
        active: opencodeProviderStatus(config) === "azure",
        storedKey: opencodeAzureStoredApiKeyRef(config),
        storedBaseUrl: opencodeAzureStoredBaseUrl(config),
      };
    },
    enable: ({ ctx, paths, apiKey, apiKeyFromFlag, baseUrl }) => enableOpencodeAzure({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      apiKey,
      apiKeyFromFlag,
      baseUrl,
      modelId: ctx.main,
    }),
    restart: () => printOpenCodeRestartHint(),
  },
  getExistingHarnessKey: async (_ctx, paths) => {
    const config = await readJsonIfExists(paths.configPath);
    return opencodeStoredApiKeyRef(config);
  },
  enable: async ({
    paths,
    apiKeyRef,
    effectiveKey,
    modelId,
    byokHeaders,
    telemetryHeaders,
  }) => {
    // Register the preferred catalog; firerouter registers only when explicitly requested. A
    // TTL-cached snapshot serves offline; a cold start with no network must
    // fail the `on` rather than register from an empty model list.
    const { ids: catalogModelIds, available: catalogAvailable } = await loadRegisterableModels({
      apiKey: effectiveKey,
    });
    return enableOpencodeFireworks({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      apiKey: apiKeyRef,
      effectiveApiKey: effectiveKey,
      modelId,
      byokHeaders,
      telemetryHeaders,
      catalogModelIds,
      catalogAvailable,
    });
  },
  envHookOn: (ctx) => finishEnvHarnessOn(ctx.home, { harnessId: "opencode" }),
  restartHint: () => printOpenCodeRestartHint(),

  disable: ({ paths, wasEnabled }) => disableOpencodeFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    wasEnabled,
  }),
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const { configPath } = opencodePathsFor(ctx);
    const config = await readJsonIfExists(configPath);
    return opencodeProviderStatus(config);
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const { configPath } = opencodePathsFor(ctx);
    const config = await readJsonIfExists(configPath);

    const model = opencodeCurrentModelId(config);
    const fireworksAi = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID] ?? null;
    const azure = config.provider?.[OPENCODE_AZURE_PROVIDER_ID] ?? null;
    const provider = opencodeProviderStatus(config);
    const storedRef = provider === "azure" ? opencodeAzureStoredApiKeyRef(config) : opencodeStoredApiKeyRef(config);
    const payload = {
      harness: HARNESS.OPENCODE,
      provider,
      baseUrl: provider === "azure" ? (azure?.options?.baseURL ?? null) : (fireworksAi?.options?.baseURL ?? null),
      hasAuthToken: provider === "azure"
        ? Boolean(effectiveAzureApiKey(storedRef))
        : Boolean(storedRef || process.env.FIREWORKS_API_KEY),
      defaults: {
        main: provider === "azure"
          ? DEFAULT_AZURE_MODEL
          : defaultMainModel(),
      },
      current: { main: model },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.OPENCODE, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: opencodeAuthKeyMode(storedRef),
      model: payload.current.main,
      endpoint: provider === "azure" ? payload.baseUrl : null,
      keySource: harnessStatusKeySource(HARNESS.OPENCODE, provider),
    });
  },

});
