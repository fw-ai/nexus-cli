import {
  printHarnessConnected,
  printNote,
  printRestartHint,
} from "../../cli/messages.mjs";
import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import process from "node:process";
import { MISSING_FIREWORKS_API_KEY_MESSAGE } from "../../keys/key-type.mjs";
import {
  loadRegisterableModels,
} from "../../fireworks/models.mjs";
import { harnessFullKey } from "../../keys/harness-api-key.mjs";
import {
  VSCODE_FIREWORKS_MODEL_URL,
  ensureVscodeStopped,
  disableVscodeFireworks,
  enableVscodeAzure,
  enableVscodeFireworks,
  fireconnectRegisteredModels,
  fireconnectSecretId,
  findFireconnectProvider,
  fireworksProviderStatus,
  readChatLanguageModels,
  readVscodeSecret,
  readVscodeStoredKey,
  relocateLegacyVscodeBackups,
  vscodeAzureProviderStatus,
  vscodeStoredByokHeaders,
} from "./core.mjs";
import { DEFAULT_AZURE_MODEL } from "../../fireworks/azure-core.mjs";
import {
  byokEnvFromHeaders,
} from "../../firerouter/core.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  vscodePathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import {
  isHarnessEnabled,
} from "../../config/global-config.mjs";
import {
  linuxSafeStorageIsObfuscatedFallback,
  linuxSafeStorageObfuscatedKeyNote,
} from "./safestorage.mjs";

/**
 * Harness-local Fireworks key for VS Code: the key stored (encrypted) in VS
 * Code's secret storage (state.vscdb) under the `chat.lm.secret.fw-*` id
 * referenced by the nexus provider. Returns "" when none is present.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function vscodeResolveKey(ctx) {
  const { vscodePath, stateDbPath } = vscodePathsFor(ctx);
  return readVscodeStoredKey(vscodePath, stateDbPath);
}

/**
 * Full resolution chain (flag > env > harness-local secret storage > global).
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function vscodeApiKey(ctx) {
  return harnessFullKey(ctx, vscodeResolveKey);
}

export default defineHarnessProfile({
  id: HARNESS.VSCODE,
  label: "VS Code",
  resolveKey: vscodeResolveKey,
  paths: (ctx) => vscodePathsFor(ctx),
  firerouter: {
    byok: "value",
    autoCatalog: true,
    catalogByok: true,
  },
  telemetryHeaders: true,
  readByokEnv: async (_ctx, paths) => byokEnvFromHeaders(
    vscodeStoredByokHeaders(await readChatLanguageModels(paths.vscodePath)),
  ),
  // VS Code's custom chat-completions endpoint can point at Microsoft Foundry.
  azure: {
    read: async (_ctx, { vscodePath, stateDbPath }) => {
      const arr = await readChatLanguageModels(vscodePath);
      const provider = findFireconnectProvider(arr);
      const secretId = provider ? fireconnectSecretId(provider.apiKey) : null;
      return {
        active: vscodeAzureProviderStatus(arr) === "azure",
        storedKey: secretId ? await readVscodeSecret({ vscodePath, stateDbPath, secretId }) : "",
        storedBaseUrl: provider?.models?.[0]?.url ?? "",
        model: provider?.models?.[0]?.id || DEFAULT_AZURE_MODEL,
      };
    },
    enable: async ({ ctx, paths, apiKey, baseUrl }) => {
      await relocateLegacyVscodeBackups({ home: ctx.home, dataDir: paths.dataDir });
      await ensureVscodeStopped({ force: ctx.force });
      return enableVscodeAzure({
        vscodePath: paths.vscodePath,
        dataDir: paths.dataDir,
        apiKey,
        baseUrl,
        modelId: ctx.main,
        stateDbPath: paths.stateDbPath,
      });
    },
    restart: () => printRestartHint("Quit and relaunch VS Code, then select the model in Chat."),
  },
  resolveOnKey: async (ctx) => {
    const token = await vscodeApiKey(ctx);
    if (!token) {
      throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
    }
    return { apiKeyRef: token, effectiveKey: token, reusedExistingKey: false };
  },
  enable: async ({
    ctx,
    paths,
    effectiveKey,
    modelId,
    byokHeaders,
    telemetryHeaders,
    includeFirerouter,
  }) => {
    // Register the preferred catalog; firerouter registers only when explicitly requested. A
    // TTL-cached snapshot serves offline; a cold start with no network must
    // fail the `on` rather than register from an empty model list.
    const { ids: catalogModelIds, available: catalogAvailable } = await loadRegisterableModels({
      apiKey: effectiveKey,
      includeFirerouter,
    });
    await relocateLegacyVscodeBackups({ home: ctx.home, dataDir: paths.dataDir });
    await ensureVscodeStopped({ force: ctx.force });
    return enableVscodeFireworks({
      vscodePath: paths.vscodePath,
      dataDir: paths.dataDir,
      apiKey: effectiveKey,
      modelId,
      stateDbPath: paths.stateDbPath,
      byokHeaders,
      telemetryHeaders,
      catalogModelIds,
      catalogAvailable,
    });
  },
  printConnected: ({ result }) => {
    printHarnessConnected("VS Code", { model: result.model });
    if (linuxSafeStorageIsObfuscatedFallback()) {
      printNote(
        "Warning: VS Code will obfuscate (not encrypt) the key because Secret Service / libsecret is unavailable for VS Code's Electron safeStorage. "
          + "Install gnome-keyring + secret-service for real encryption. "
          + "(Nexus's own API key storage shown in `nexus status` is separate.)",
      );
    } else if (result.obfuscatedKey) {
      printNote(linuxSafeStorageObfuscatedKeyNote(result.variant ?? "stable"));
    }
  },
  restartHint: () => printRestartHint("Quit and relaunch VS Code, then select the model in Chat."),

  // `on` and `off` both write state.vscdb (`on` stores the safeStorage
  // secret; `off` deletes it), so the IDE must be stopped before either —
  // gated in `enable` below and in `prepareOff`.
  envHookOff: false,
  prepareOff: (ctx) => ensureVscodeStopped({ force: ctx.force }),
  disable: async ({ ctx, paths, wasEnabled }) => {
    await relocateLegacyVscodeBackups({ home: ctx.home, dataDir: paths.dataDir });
    return disableVscodeFireworks({
    vscodePath: paths.vscodePath,
    dataDir: paths.dataDir,
    wasEnabled,
    stateDbPath: paths.stateDbPath,
  });
  },
  restartHintOff: () => printRestartHint("Restart VS Code for the change to take effect."),
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    const paths = vscodePathsFor(ctx);
    await relocateLegacyVscodeBackups({ home: ctx.home, dataDir: paths.dataDir });
    const { vscodePath } = paths;
    const arr = await readChatLanguageModels(vscodePath);
    if (vscodeAzureProviderStatus(arr) === "azure") return "azure";
    return fireworksProviderStatus(arr);
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    const paths = vscodePathsFor(ctx);
    await relocateLegacyVscodeBackups({ home: ctx.home, dataDir: paths.dataDir });
    const { vscodePath, stateDbPath } = paths;
    const enabled = await isHarnessEnabled(ctx.home, HARNESS.VSCODE);
    const arr = await readChatLanguageModels(vscodePath);

    if (vscodeAzureProviderStatus(arr) === "azure") {
      const azureProvider = findFireconnectProvider(arr);
      const deployment = azureProvider?.models?.[0]?.id ?? null;
      const azureBaseUrl = azureProvider?.models?.[0]?.url ?? null;
      const azureSecretId = azureProvider ? fireconnectSecretId(azureProvider.apiKey) : null;
      const azureKey = azureSecretId
        ? await readVscodeSecret({ vscodePath, stateDbPath, secretId: azureSecretId })
        : "";
      const payload = {
        harness: HARNESS.VSCODE,
        enabled,
        provider: "azure",
        baseUrl: azureBaseUrl,
        modelProvider: "fireworks-azure",
        hasKey: Boolean(azureKey),
        defaults: { main: DEFAULT_AZURE_MODEL },
        current: { main: deployment },
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printStructuredHarnessStatus(HARNESS.VSCODE, {
        provider: payload.provider,
        keyConfigured: payload.hasKey,
        authMode: "literal",
        model: deployment,
        endpoint: azureBaseUrl,
      });
      return;
    }

    const provider = fireworksProviderStatus(arr);
    const registered = fireconnectRegisteredModels(arr);
    const storedKey = await readVscodeStoredKey(vscodePath, stateDbPath, arr);
    const keyType = provider === "none" ? "none" : "fireworks";

    const payload = {
      harness: HARNESS.VSCODE,
      enabled,
      provider,
      modelUrl: registered.length ? VSCODE_FIREWORKS_MODEL_URL : null,
      hasKey: Boolean(storedKey),
      keyType,
      registeredModels: registered,
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.VSCODE, {
      provider: payload.provider,
      keyConfigured: payload.hasKey,
      authMode: "literal",
      model: registered.length === 1 ? registered[0] : undefined,
      registeredModels: registered.length === 1 ? [] : registered,
      keySource: harnessStatusKeySource(HARNESS.VSCODE, provider, { whenFireworks: false }),
    });
  },
});
