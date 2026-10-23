import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  printDeepseekRestartHint,
} from "../../cli/messages.mjs";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import { byokEnvFromHeaders } from "../../firerouter/core.mjs";
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_FIREWORKS_BASE_URL,
  DEEPSEEK_FIREWORKS_PROVIDER_ID,
  deepseekEffectiveFireworksState,
  deepseekStoredProviderHeaders,
  disableDeepseekFireworks,
  enableDeepseekFireworks,
  readDeepseekCredentialsIfExists,
  readDeepseekSettingsIfExists,
  resolveDeepseekApiKey,
} from "./core.mjs";
import { harnessHasFullKey } from "../../keys/harness-api-key.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  deepseekPathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function deepseekResolveKey(ctx) {
  const { settingsPath, credentialsPath } = deepseekPathsFor(ctx);
  const { settings } = await readDeepseekSettingsIfExists(settingsPath);
  const effective = await deepseekEffectiveFireworksState(settingsPath, settings);
  if (effective.provider !== "fireworks") {
    return "";
  }
  const { credentials } = await readDeepseekCredentialsIfExists(credentialsPath);
  return resolveDeepseekApiKey({
    mode: deepseekAuthModeFor(effective.provider, credentials),
    credentials,
  });
}

/** Auth mode from the effective provider (settings or profile patch). */
function deepseekAuthModeFor(provider, credentials) {
  if (provider !== "fireworks") {
    return "missing";
  }
  const stored = credentials[DEEPSEEK_API_KEY_ENV];
  return typeof stored === "string" && stored.trim() ? "literal" : "env-reference";
}

export default defineHarnessProfile({
  id: HARNESS.DEEPSEEK,
  label: "DeepSeek Harness",
  resolveKey: deepseekResolveKey,
  paths: (ctx) => deepseekPathsFor(ctx),
  keyEnvRef: DEEPSEEK_API_KEY_ENV,
  // The dsh provider profile carries per-request headers: telemetry, the
  // `nexus auto` scope, and the provider keys Nexus Auto reads.
  firerouter: {
    byok: "value",
    autoCatalog: true,
  },
  telemetryHeaders: true,
  readByokEnv: async (_ctx, paths) => {
    try {
      const { settings } = await readDeepseekSettingsIfExists(paths.settingsPath);
      return byokEnvFromHeaders(deepseekStoredProviderHeaders(settings));
    } catch {
      // An unparseable settings.yaml has no keys to keep; `on` reports it.
      return {};
    }
  },
  getExistingHarnessKey: async (_ctx, paths) => {
    const { settings } = await readDeepseekSettingsIfExists(paths.settingsPath);
    const effective = await deepseekEffectiveFireworksState(paths.settingsPath, settings);
    if (effective.provider !== "fireworks") {
      return "";
    }
    const { credentials } = await readDeepseekCredentialsIfExists(paths.credentialsPath);
    return credentials[DEEPSEEK_API_KEY_ENV] ?? "";
  },
  enable: ({ paths, effectiveKey, modelId, byokHeaders = {}, telemetryHeaders = {} }) => enableDeepseekFireworks({
    settingsPath: paths.settingsPath,
    credentialsPath: paths.credentialsPath,
    dataDir: paths.dataDir,
    effectiveApiKey: effectiveKey,
    modelId,
    headers: { ...telemetryHeaders, ...byokHeaders },
  }),
  envHookOn: (ctx, effectiveKey) => finishEnvHarnessOn(ctx.home, {
    harnessId: "deepseek",
    expectedKey: effectiveKey,
  }),
  restartHint: () => printDeepseekRestartHint(),
  disable: ({ paths, wasEnabled }) => disableDeepseekFireworks({
    settingsPath: paths.settingsPath,
    credentialsPath: paths.credentialsPath,
    dataDir: paths.dataDir,
    wasEnabled,
  }),
  restartHintOff: (outcome) => {
    if (outcome !== "unchanged") {
      printDeepseekRestartHint();
    }
  },
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPSEEK);
    const { settingsPath } = deepseekPathsFor(ctx);
    const { settings } = await readDeepseekSettingsIfExists(settingsPath);
    return (await deepseekEffectiveFireworksState(settingsPath, settings)).provider;
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPSEEK);
    const { settingsPath, credentialsPath } = deepseekPathsFor(ctx);
    const [{ settings }, { credentials }] = await Promise.all([
      readDeepseekSettingsIfExists(settingsPath),
      readDeepseekCredentialsIfExists(credentialsPath),
    ]);

    const effective = await deepseekEffectiveFireworksState(settingsPath, settings);
    const provider = effective.provider;
    const apiKeyMode = deepseekAuthModeFor(provider, credentials);
    const model = effective.model;
    // Presence only: reading the stored key here would cost a keychain
    // prompt on every status call.
    const hasAuthToken = await harnessHasFullKey(ctx, async () => (
      provider === "fireworks"
        ? resolveDeepseekApiKey({ mode: apiKeyMode, credentials })
        : ""
    ));
    const payload = {
      harness: HARNESS.DEEPSEEK,
      provider,
      baseUrl: DEEPSEEK_FIREWORKS_BASE_URL,
      modelProvider: DEEPSEEK_FIREWORKS_PROVIDER_ID,
      hasAuthToken,
      apiKeyMode,
      defaults: { main: defaultMainModel() },
      current: { main: model },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.DEEPSEEK, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: payload.apiKeyMode,
      model: payload.current.main,
      keySource: harnessStatusKeySource(HARNESS.DEEPSEEK, payload.provider),
    });
  },
});
