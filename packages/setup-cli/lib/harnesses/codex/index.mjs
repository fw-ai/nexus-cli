import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  PROVIDER_KEYS_DOCS_URL,
  printHarnessConnected,
  printNote,
} from "../../cli/messages.mjs";
import path from "node:path";
import process from "node:process";
import {
  FIREROUTER_MODEL_ID,
  firerouterNamesAnthropicModel,
  isFirerouterModel,
  isRetiredModelId,
} from "../../fireworks/model-id.mjs";
import { isFirerouterModelPattern } from "../../fireworks/model-specs.mjs";
import {
  CODEX_API_KEY_ENV_REF,
  CODEX_AZURE_PROVIDER_ID,
  CODEX_AZURE_PROVIDER_TABLE,
  CODEX_CHATGPT_FIREWORKS_KEY_HEADER,
  CODEX_DEFAULT_MODEL,
  CODEX_FIREWORKS_BASE_URL,
  CODEX_FIREWORKS_PROVIDER_ID,
  CODEX_PROVIDER_TABLE,
  codexAuthKeyMode,
  codexChatgptLoginFireworksKey,
  codexCurrentModelId,
  codexProviderStatus,
  codexStoredAuthRef,
  disableCodexFireworks,
  effectiveCodexApiKey,
  enableCodexFireworks,
  loadCodexCatalogBundle,
  printCodexRestartHint,
  readCodexTomlIfExists,
} from "./core.mjs";
import { DEFAULT_AZURE_MODEL } from "../../fireworks/azure-core.mjs";
import { isFireworksKey } from "../../keys/key-type.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import { readProviderSettings } from "../../config/global-config.mjs";
import { ANTHROPIC_BYOK_HEADER, byokEnvFromHeaders } from "../../firerouter/core.mjs";
import { resolveAutoProviderKeyHeaders } from "../../firerouter/flag.mjs";
import {
  codexPathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import {
  codexModelExclusionReason,
  isCodexOpenaiModelSlug,
} from "./catalog.mjs";
import { ensureChatGptStopped, ensureCodexSessionsClosed, isCodexSessionRunning } from "./ide-running.mjs";
import { refreshCodexStockModels } from "./stock-models.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import { existsSync } from "node:fs";

const CODEX_PROVIDER_KEYS_REMOVED_NOTE =
  "Codex now pays for GPT turns only with its own sign-in, so Nexus CLI removed the "
  + "provider-key headers from config.toml. To pay with an OpenAI key, sign Codex in with it: "
  + "`codex login --with-api-key`.";

// Both readers of config.toml and the model catalog load them once at boot: the
// ChatGPT app, and the app-server daemon every `codex` session shares. Writing
// while either is up changes nothing it serves, so wait for both to be closed.
async function ensureCodexStopped(ctx) {
  await ensureChatGptStopped({ force: ctx.force });
  await ensureCodexSessionsClosed({ force: ctx.force });
}

// Codex's own sign-in pays for GPT turns, so Nexus forwards no provider key.
const CODEX_FIREROUTER = Object.freeze({
  byok: "none",
  autoCatalog: true,
});

async function codexResolveKey(ctx) {
  const { configPath } = codexPathsFor(ctx);
  const { doc } = await readCodexTomlIfExists(configPath);
  if (codexProviderStatus(doc) !== "fireworks") {
    return "";
  }
  const key = effectiveCodexApiKey(codexStoredAuthRef(doc));
  return isFireworksKey(key) ? key.trim() : "";
}

async function codexResolveOnContext(ctx) {
  // Codex CLI 0.160+ dropped `wire_api = "chat"`, the only transport Foundry
  // offers. Reject --azure and a persisted `provider: azure` up front instead
  // of silently switching a former Foundry user to the gateway.
  const { provider } = await readProviderSettings(ctx.home);
  if (ctx.azure || provider === "azure") {
    throw new Error(
      "Codex no longer supports Azure/Foundry mode: Codex CLI 0.160+ removed `wire_api = \"chat\"`. " +
      "Run `nexus configure --provider fireworks` to use the Fireworks gateway.",
    );
  }
  // The GPT rows, and which GPT IDs `--model` accepts, follow stock Codex's own
  // list, so read it before anything checks the requested model.
  if (ctx.home?.trim()) {
    await refreshCodexStockModels({ codexHome: path.dirname(codexPathsFor(ctx).configPath) });
  }
  // Any spelling of bare `firerouter` is stored as the bare route id.
  if (ctx.main?.trim()) {
    return isFirerouterModel(ctx.main) ? { ...ctx, main: FIREROUTER_MODEL_ID } : ctx;
  }
  const home = ctx.home?.trim() ?? "";
  if (!home) {
    return ctx;
  }
  // A first `on` lands on `auto`; a re-`on` keeps the current model, except
  // that a FireRouter selection carried over from an earlier `on` is dropped
  // to `auto` instead of being kept.
  const { configPath } = codexPathsFor(ctx);
  const { doc } = await readCodexTomlIfExists(configPath);
  const current = codexProviderStatus(doc) === "fireworks" ? codexCurrentModelId(doc) : "";
  if (current && !isRetiredModelId(current)) {
    return ctx;
  }
  return { ...ctx, main: CODEX_DEFAULT_MODEL, modelImplied: true };
}

export default defineHarnessProfile({
  id: HARNESS.CODEX,
  label: "Codex",
  resolveKey: codexResolveKey,
  resolveOnContext: codexResolveOnContext,
  paths: (ctx) => codexPathsFor(ctx),
  keyEnvRef: CODEX_API_KEY_ENV_REF,
  firerouter: CODEX_FIREROUTER,
  telemetryHeaders: true,
  getExistingHarnessKey: async (_ctx, paths) => {
    const { doc } = await readCodexTomlIfExists(paths.configPath);
    // Only reuse a stored key when the gateway provider is active — an Azure
    // bearer / {env:AZURE_API_KEY} ref must never be read as the Fireworks key
    // when switching from Foundry back to the gateway.
    return codexProviderStatus(doc) === "fireworks" ? codexStoredAuthRef(doc) : "";
  },
  servedOutsideCatalog: (modelId) => isCodexOpenaiModelSlug(modelId),
  enable: async ({
    ctx,
    paths,
    apiKeyRef,
    effectiveKey,
    modelId,
    telemetryHeaders,
  }) => {
    await ensureCodexStopped(ctx);
    const { doc } = await readCodexTomlIfExists(paths.configPath);
    const anthropicKey = (await resolveAutoProviderKeyHeaders({
      home: ctx.home,
      settingsEnv: byokEnvFromHeaders(doc.tables[CODEX_PROVIDER_TABLE]?.http_headers),
      openai: false,
    }))[ANTHROPIC_BYOK_HEADER] ?? "";
    const exclusionReason = codexModelExclusionReason(modelId);
    if (exclusionReason) {
      throw new Error(exclusionReason);
    }
    const { codexCatalog, snapshot, catalogAvailable } = await loadCodexCatalogBundle(effectiveKey, {
      modelId,
    });
    return enableCodexFireworks({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      apiKey: apiKeyRef,
      effectiveApiKey: effectiveKey,
      modelId,
      catalogPath: paths.catalogPath,
      catalog: codexCatalog,
      catalogSnapshot: snapshot,
      catalogAvailable,
      refreshCatalog: ctx.modelImplied === true,
      telemetryHeaders,
      anthropicKey,
    });
  },
  envHookOn: (ctx) => finishEnvHarnessOn(ctx.home, { harnessId: "codex" }),
  printConnected: ({ result }) => {
    printHarnessConnected("Codex", { model: result.model });
    printNote(
      "Codex keeps its own sign-in: sign in with ChatGPT and GPT turns use your plan. "
        + "Run `codex login` if Codex asks you to sign in.",
    );
    if (result.removedProviderKeys) {
      printNote(CODEX_PROVIDER_KEYS_REMOVED_NOTE);
    }
    if (isCodexOpenaiModelSlug(result.model)) {
      printNote(
        `Signing Codex in with only your Fireworks key? ${result.model} then needs an OpenAI `
          + `Provider Key on your Fireworks account: ${PROVIDER_KEYS_DOCS_URL}. Without one, use `
          + "`auto`, which falls back to open models.",
      );
    }
    if (firerouterNamesAnthropicModel(result.model)) {
      printNote(
        "Codex doesn't send an Anthropic key, so Claude turns on this route need an Anthropic "
          + `Provider Key on your Fireworks account: ${PROVIDER_KEYS_DOCS_URL}.`,
      );
    }
  },
  restartHint: () => printCodexRestartHint(),

  // Stop the app and Codex sessions before `off` rewrites config.toml/removes
  // the catalog — they cache the model list at boot. Mirrors Cursor/VS Code's
  // `prepareOff`.
  prepareOff: (ctx) => ensureCodexStopped(ctx),
  disable: async ({ paths, wasEnabled }) => disableCodexFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    catalogPath: paths.catalogPath,
    wasEnabled,
  }),
  restartHintOff: () => printCodexRestartHint({ resume: false, sessionsOpen: isCodexSessionRunning() }),
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    return codexProviderStatus(doc);
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath, catalogPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    const provider = codexProviderStatus(doc);

    if (provider === "azure") {
      const azureTable = doc.tables[CODEX_AZURE_PROVIDER_TABLE] ?? {};
      const storedAuth = codexStoredAuthRef(doc);
      const payload = {
        harness: HARNESS.CODEX,
        provider,
        baseUrl: typeof azureTable.base_url === "string" ? azureTable.base_url : null,
        modelProvider: CODEX_AZURE_PROVIDER_ID,
        hasAuthToken: Boolean(effectiveCodexApiKey(storedAuth)),
        defaults: { main: DEFAULT_AZURE_MODEL },
        current: { main: codexCurrentModelId(doc) },
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printStructuredHarnessStatus(HARNESS.CODEX, {
        provider: payload.provider,
        keyConfigured: payload.hasAuthToken,
        authMode: codexAuthKeyMode(storedAuth),
        model: payload.current.main,
        endpoint: payload.baseUrl,
      });
      return;
    }

    const model = codexCurrentModelId(doc);
    const storedAuth = codexStoredAuthRef(doc);
    const chatgptLogin = provider === "fireworks"
      && Boolean(codexChatgptLoginFireworksKey(doc.tables[CODEX_PROVIDER_TABLE]));
    const payload = {
      harness: HARNESS.CODEX,
      provider,
      baseUrl: CODEX_FIREWORKS_BASE_URL,
      modelProvider: CODEX_FIREWORKS_PROVIDER_ID,
      hasAuthToken: Boolean(storedAuth || process.env.FIREWORKS_API_KEY),
      chatgptLogin,
      ...(chatgptLogin ? { fireworksKeyHeader: CODEX_CHATGPT_FIREWORKS_KEY_HEADER } : {}),
      defaults: { main: CODEX_DEFAULT_MODEL },
      current: { main: model },
      modelCatalog: {
        set: Boolean(doc.root.model_catalog_json),
        path: catalogPath,
        exists: existsSync(catalogPath),
      },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.CODEX, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: codexAuthKeyMode(storedAuth),
      model: payload.current.main,
      keySource: chatgptLogin
        ? `Codex sign-in; Fireworks key in ${CODEX_CHATGPT_FIREWORKS_KEY_HEADER} header in config.toml`
        : harnessStatusKeySource(HARNESS.CODEX, provider),
    });
  },

});
