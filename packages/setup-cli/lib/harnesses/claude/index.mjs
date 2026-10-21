import process from "node:process";

import {
  printClaudeRestartHint,
  printClaudeModelActivationHint,
  printClaudeModelManagementHints,
  printHarnessOnSuccess,
  printHarnessRestored,
  printNote,
} from "../../cli/messages.mjs";
import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  claudeFireconnectIntent,
  disableFireworksProvider,
  enableFireworksProvider,
  mappingFromSettings,
  hasLegacyAnthropicMainEnv,
  providerBackupPath,
  providerStatePath,
  providerStatusFromEnv,
  resolveClaudeDefaultModel,
  stripFireconnectManagedClaudeSettings,
  stripManagedApiKeyHelper,
} from "./core.mjs";
import {
  FIREWORKS_BASE_URL,
} from "../../fireworks/model-id.mjs";
import { assertRequestedModelsServable } from "../../fireworks/model-servability.mjs";
import {
  isAnthropicModelId,
  isClaudeModelAlias,
  isClaudeNativeModel,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  isFireworksKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { withoutDesktopGuardHook } from "./desktop-guard.mjs";
import {
  originalSettingsDeniedServerTools,
  reconcileGatewayServerToolDenials,
  withoutGatewayServerToolsDenied,
} from "./server-tools-deny.mjs";
import {
  formatClaudeUsageReport,
  formatClaudeUsageReports,
  readClaudeUsage,
  readClaudeUsages,
} from "./usage/report.mjs";
import {
  canRunClaudeUsageInteractiveDisplay,
  hasClaudeUsageRows,
  playUsageIntroAnimation,
  runClaudeUsageInteractiveDisplay,
} from "./usage/display.mjs";
import { runClaudeUsageLive, shouldRunClaudeUsageLive } from "./usage/live.mjs";
import { promptClaudeUsageSession } from "./usage/session-picker.mjs";
import { runClaudeLiveTmux } from "./live-tmux.mjs";
import {
  attachPricing,
  CLAUDE_CODE_PRICING_DISCLAIMER,
} from "../../fireworks/pricing.mjs";
import { loadRegisterableModels, warmServerlessPricingCache } from "../../fireworks/models.mjs";
import {
  formatNonVisionModelsWarning,
  uniqueNonVisionModelShortIds,
} from "../../fireworks/vision.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  claudePathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import {
  isHarnessEnabled,
  readGlobalConfig,
  setHarnessEnabled,
  setHarnessState,
} from "../../config/global-config.mjs";
import { formatAutoProviders } from "../../config/auto-providers.mjs";
import { HARNESS } from "../../harness/id.mjs";
import {
  fireworksKeyFromCustomHeaders,
  isOpenAIShapedKey,
  resolveOpenaiKey,
} from "../../firerouter/core.mjs";
import {
  harnessStatusKeySource,
  persistApiKeyFromFlag,
  resolveFireworksApiKeyValue,
} from "../../keys/api-key.mjs";
import { harnessFullKey } from "../../keys/harness-api-key.mjs";
import { detectSecretBackend } from "../../keys/secret-store.mjs";
import { assertBackendCanStore } from "../../keys/storage-report.mjs";
import { disableWebsearchMcp } from "../../system/websearch-mcp.mjs";
import { claudeJsonPath } from "../../system/websearch-state.mjs";
import {
  printClaudePickerSummary,
} from "./onboarding.mjs";
import {
  readClaudeActivationSnapshot,
  resolveClaudeActivationPlan,
} from "./activation.mjs";
import {
  claudeBareFirerouterRequested,
  claudeExtraPickerModelFromCtx,
  claudeSlotOverridesFromCtx,
} from "./connect.mjs";
import {
  assertClaudeModelOverrides,
  claudeActiveMappingIsCurrent,
  claudeMappingNeedsOpenaiKey,
  defaultClaudeModelMapping,
  mappingUsesBareFirerouter,
  withSavedClaudeModelMapping,
} from "./model-profile.mjs";
import {
  isFireconnectModelPicker,
  validateClaudeModelPicker,
} from "./settings-model-picker.mjs";

const CLAUDE_FIREROUTER = Object.freeze({
  byok: "none",
  autoCatalog: true,
  // Claude Code's own sign-in pays for Claude turns; Nexus only carries
  // an OpenAI key, in ANTHROPIC_CUSTOM_HEADERS.
  customHeaderOpenaiKey: true,
});

export const CLAUDE_ANTHROPIC_KEY_REMOVED_NOTE =
  "Nexus no longer writes an Anthropic key into Claude Code's settings, so it removed the "
  + "one an earlier `nexus claude` saved. Claude Code's own sign-in pays for Claude turns: "
  + "run `claude login`, or export ANTHROPIC_API_KEY to pay with a key.";

export const CLAUDE_LEGACY_ANTHROPIC_MODEL_WARNING =
  "Legacy env.ANTHROPIC_MODEL is still set and overrides Claude Code's /model picker. "
  + "Run `nexus claude` to migrate.";

export function resolveClaudeAuthState(settings, state = {}) {
  const env = settings.env ?? {};
  const customHeaderToken = fireworksKeyFromCustomHeaders(
    env.ANTHROPIC_CUSTOM_HEADERS,
  );
  if (isFireworksKey(customHeaderToken)) {
    return {
      authMode: "customHeader",
      keyConfigured: true,
      token: customHeaderToken.trim(),
    };
  }

  const usesHelper = Boolean(settings.apiKeyHelper)
    || state.authMode === "apiKeyHelper";
  if (usesHelper) {
    return { authMode: "apiKeyHelper", keyConfigured: true, token: "" };
  }

  const token = [
    env.ANTHROPIC_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
    state.fireworksApiKey,
  ].find(isFireworksKey)?.trim() ?? "";
  return {
    authMode: token ? "env" : "missing",
    keyConfigured: Boolean(token),
    token,
  };
}

/**
 * Fireworks key from active Claude Code settings when Fireconnect is on.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function claudeResolveKey(ctx) {
  const { settingsPath, dataDir } = claudePathsFor(ctx);
  const settings = await readJsonIfExists(settingsPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  return resolveClaudeAuthState(settings, state).token;
}

/**
 * Resolve before any Claude settings mutation. Claude `on` intentionally stops
 * with explicit login/custom-SSO guidance instead of starting sign-in itself.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function claudeApiKeyForOn(ctx, snapshot) {
  const token = await harnessFullKey(
    ctx,
    async () => resolveClaudeAuthState(snapshot.settings, snapshot.state).token,
  );
  if (token) {
    return token;
  }
  throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
}

function isNativeClaudeCredential(value) {
  const key = typeof value === "string" ? value.trim() : "";
  // Older releases also wrote Fire Pass (fpk_) keys; never keep one as Anthropic auth.
  return Boolean(key) && key !== "fireconnect" && !isFireworksKey(key) && !key.startsWith("fpk_");
}

function settingsFromSnapshot(backup) {
  if (backup.snapshot === undefined) {
    return null;
  }
  if (!backup.snapshot?.existed) {
    return {};
  }
  return JSON.parse(backup.snapshot.raw);
}

/**
 * Return the auth-bearing settings Claude had before Nexus. A current
 * v0.9 mapping uses its raw snapshot; a v0.8 values backup exposes the restored
 * auth fields directly. Backup-less v0.8 installs retain only credentials that
 * cannot be Nexus's own key/sentinel.
 */
export function claudeNativeAuthBaseline(settings, backup = {}, state = {}, intent = null) {
  const snapshot = settingsFromSnapshot(backup);
  if (snapshot !== null) {
    return snapshot;
  }
  if (backup.values !== undefined) {
    const baseline = { env: { ...(backup.values ?? {}) } };
    if (Object.hasOwn(backup.topLevel?.values ?? {}, "apiKeyHelper")) {
      baseline.apiKeyHelper = backup.topLevel.values.apiKeyHelper;
    }
    return baseline;
  }
  if (!intent) {
    return settings;
  }

  const baseline = stripFireconnectManagedClaudeSettings(settings, state);
  const currentEnv = settings.env ?? {};
  const env = { ...(baseline.env ?? {}) };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    if (isNativeClaudeCredential(currentEnv[key])) {
      env[key] = currentEnv[key];
    }
  }
  return { ...baseline, env };
}

/**
 * The Anthropic credentials Claude Code had before Nexus. Nexus
 * never adds one: Claude Code's own sign-in pays for Claude turns.
 */
function resolveClaudeNativeAuth({ baseline, state }) {
  const baselineEnv = baseline.env ?? {};
  const anthropicApiKey = isNativeClaudeCredential(baselineEnv.ANTHROPIC_API_KEY)
    ? baselineEnv.ANTHROPIC_API_KEY.trim()
    : "";
  const anthropicAuthToken = isNativeClaudeCredential(baselineEnv.ANTHROPIC_AUTH_TOKEN)
    ? baselineEnv.ANTHROPIC_AUTH_TOKEN.trim()
    : "";
  const helperResult = stripManagedApiKeyHelper(baseline, state).settings;
  const nativeApiKeyHelper = Object.hasOwn(helperResult, "apiKeyHelper")
    ? helperResult.apiKeyHelper
    : null;
  return { anthropicApiKey, anthropicAuthToken, nativeApiKeyHelper };
}

/**
 * Pre-approve a stray ANTHROPIC_API_KEY in ~/.claude.json so Claude Code doesn't
 * show its one-time "Detected a custom API key in your environment" prompt.
 * Nexus authenticates via the X-Fireworks-Api-Key header (that key still
 * wins), but a user who exports ANTHROPIC_API_KEY would otherwise get prompted on
 * first launch. Claude Code identifies an approved key by `key.trim().slice(-20)`
 * stored in customApiKeyResponses.approved. No-op when no key is in the env.
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function approveStrayAnthropicApiKey(home) {
  const key = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (!home || !key) {
    return false;
  }
  const identifier = key.slice(-20);
  const filePath = claudeJsonPath(home);
  const current = await readJsonIfExists(filePath);
  const responses = (current.customApiKeyResponses && typeof current.customApiKeyResponses === "object")
    ? current.customApiKeyResponses
    : {};
  const approved = Array.isArray(responses.approved) ? responses.approved : [];
  if (approved.includes(identifier)) {
    return false;
  }
  await writeJson(filePath, {
    ...current,
    customApiKeyResponses: {
      ...responses,
      approved: [...approved, identifier],
      rejected: Array.isArray(responses.rejected) ? responses.rejected : [],
    },
  });
  return true;
}

/** Strip a legacy SessionStart desktop-guard hook left by older FireConnect installs. */
async function removeDesktopGuardHook(settingsPath) {
  const settings = await readJsonIfExists(settingsPath);
  const next = withoutDesktopGuardHook(settings);
  if (next !== settings) {
    await writeJson(settingsPath, next);
  }
}

// Remove legacy FireConnect-added server-tool denials while preserving rules
// that were present in the user's original settings.
async function reconcileServerToolDenials(settingsPath, preserveDeniedTools) {
  const settings = await readJsonIfExists(settingsPath);
  const next = reconcileGatewayServerToolDenials(settings, { preserveDeniedTools });
  if (next !== settings) {
    await writeJson(settingsPath, next);
  }
}

function legacyBackupIncludesPermissions(backup) {
  return Object.hasOwn(backup.topLevel?.values ?? {}, "permissions")
    || (backup.topLevel?.missing ?? []).includes("permissions");
}

async function prepareClaudeV09Baseline({ settingsPath, dataDir, intent }) {
  if (!intent?.needsUpgrade) {
    return;
  }

  const backupPath = providerBackupPath(dataDir);
  const backup = await readJsonIfExists(backupPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  const hasLegacyBackup = backup.values !== undefined;
  if (hasLegacyBackup) {
    await disableFireworksProvider({ settingsPath, dataDir, wasEnabled: true });
  } else {
    const settings = await readJsonIfExists(settingsPath);
    await writeJson(
      settingsPath,
      stripFireconnectManagedClaudeSettings(settings, state),
      { mode: 0o600 },
    );
  }

  let baseline = await readJsonIfExists(settingsPath);
  baseline = withoutDesktopGuardHook(baseline);
  if (!hasLegacyBackup || !legacyBackupIncludesPermissions(backup)) {
    baseline = withoutGatewayServerToolsDenied(baseline);
  }
  await writeJson(settingsPath, baseline, { mode: 0o600 });
}

export default defineHarnessProfile({
  id: HARNESS.CLAUDE,
  label: "Claude Code",
  resolveKey: claudeResolveKey,
  firerouter: CLAUDE_FIREROUTER,
  // Claude's `on` is bespoke (slot mapping and raw-snapshot backup).
  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const onboardingMode = ctx.onboardingMode ?? "auto";
    if (onboardingMode === "prompt") {
      throw new Error(
        "--interactive is not supported. Use `--model <id>` to choose a Fireworks model "
          + "and add it to Claude Code's /model picker.",
      );
    }
    assertClaudeModelOverrides(ctx);
    const snapshot = await readClaudeActivationSnapshot(ctx);
    const { settingsPath, dataDir } = snapshot;
    const preserveDeniedServerTools = originalSettingsDeniedServerTools(
      snapshot.settings,
      snapshot.backup,
    );
    const fireworksKey = await claudeApiKeyForOn(ctx, snapshot);
    if (ctx.openaiKeyFromFlag && !isOpenAIShapedKey(ctx.openaiKey)) {
      throw new Error("--openai-api-key must be an OpenAI API key (sk-..., not sk-ant-...).");
    }
    const activeToken = resolveClaudeAuthState(snapshot.settings, snapshot.state).token;
    validateClaudeModelPicker(snapshot.settings);
    // Normalize first so friendly aliases like `native` are seen as the native
    // sentinel (claude-default) before the servability check, not as a bare,
    // unrecognized model id.
    const extraPickerModel = claudeExtraPickerModelFromCtx(ctx);
    const slotOverrides = claudeSlotOverridesFromCtx(ctx);
    await assertRequestedModelsServable(
      [extraPickerModel, ...Object.values(slotOverrides)]
        .filter((modelId) => modelId && !isClaudeNativeModel(modelId)),
      { apiKey: fireworksKey },
    );
    const nativeBaseline = claudeNativeAuthBaseline(
      snapshot.settings,
      snapshot.backup,
      snapshot.state,
      snapshot.intent,
    );
    const nativeAuth = resolveClaudeNativeAuth({
      baseline: nativeBaseline,
      state: snapshot.state,
    });
    const currentAnthropicKey = snapshot.settings.env?.ANTHROPIC_API_KEY?.trim() ?? "";
    const removedAnthropicKey = isNativeClaudeCredential(currentAnthropicKey)
      && currentAnthropicKey !== nativeAuth.anthropicApiKey;
    // Claude Code keeps its own OAuth/subscription login and attaches Anthropic
    // auth at request time. Nexus does not probe for that login.
    const activeMappingIsCurrent = Boolean(snapshot.intent) && claudeActiveMappingIsCurrent({
      legacyFirePass: snapshot.legacyFirePass,
      tokenIsFireworks: isFireworksKey(activeToken),
      recordedKeyType: snapshot.state.keyType,
      profiles: snapshot.profiles,
      activeMapping: snapshot.intent.mapping,
    });
    const plan = resolveClaudeActivationPlan({
      ctx,
      snapshot,
      activeMappingIsCurrent,
    });
    const mapping = plan.mapping;
    // FireRouter no longer registers (a FireRouter `--model` is rejected at
    // admission); a plain `on` must not re-add the row an earlier `on` left
    // in the picker.
    const { ids } = await loadRegisterableModels({
      apiKey: fireworksKey,
      includeFirerouter: false,
    });
    const registerablePickerIds = ids
      .map((id) => shortFireworksModelRef(id))
      .filter(Boolean);
    if (extraPickerModel) {
      const shortId = shortFireworksModelRef(extraPickerModel);
      if (shortId && !registerablePickerIds.includes(shortId)) {
        registerablePickerIds.unshift(shortId);
      }
    }
    const bareFirerouter = claudeBareFirerouterRequested(extraPickerModel)
      || mappingUsesBareFirerouter(mapping);
    // Preserve native Anthropic credentials already in Claude settings (subscription
    // or BYOK the user configured in Claude Code). FireRouter does not require
    // Nexus to inject x-anthropic-api-key — Claude Code attaches auth.
    const anthropicKeyForSettings = nativeAuth.anthropicApiKey;
    // A configured OpenAI key rides along as x-openai-api-key on FireRouter
    // picks that can route to OpenAI (see `claudeMappingNeedsOpenaiKey`), the
    // same attach rule as `resolveFirerouterByokHeaders`. Checked against the
    // /model default `on` will actually write. Missing stays absent, never
    // an error.
    const defaultModel = resolveClaudeDefaultModel({
      currentModel: snapshot.settings.model,
      selectedPickerModel: extraPickerModel ?? "",
      mapping,
      registerablePickerIds,
    });
    const openaiKeyForSettings = claudeMappingNeedsOpenaiKey(mapping, defaultModel)
      ? await resolveOpenaiKey({
        apiKey: ctx.openaiKeyFromFlag ? ctx.openaiKey : "",
        settingsEnv: {
          ANTHROPIC_CUSTOM_HEADERS: snapshot.settings.env?.ANTHROPIC_CUSTOM_HEADERS ?? "",
        },
        home: ctx.home,
      })
      : "";

    // Migrate a harness-local key (baked into settings by an older `on`) into the
    // shared store so `key export` and other harnesses can reuse it — but only
    // when flag/env/stored are all empty, so a newer key from `login`/env is
    // never clobbered (matches resolveHarnessOnApiKey's precedence). `--api-key`
    // is already persisted by runHarnessCommand; a prompted key persists itself.
    const flagKey = ctx.apiKey?.trim() ?? "";
    const migrated = !flagKey
      && isFireworksKey(fireworksKey)
      && !(await resolveFireworksApiKeyValue({ home: ctx.home }));
    if (migrated) {
      const backend = await detectSecretBackend(ctx.home);
      await assertBackendCanStore(backend, ctx.home);
      await persistApiKeyFromFlag(ctx.home, fireworksKey, { backend });
    }
    await prepareClaudeV09Baseline({
      settingsPath,
      dataDir,
      intent: snapshot.intent,
    });
    const nexusProviders = formatAutoProviders(
      (await readGlobalConfig(ctx.home)).auto.providers,
    );
    const { settings: enabledSettings } = await enableFireworksProvider({
      settingsPath,
      dataDir,
      effectiveApiKey: fireworksKey,
      baseUrl: ctx.baseUrl || FIREWORKS_BASE_URL,
      mapping,
      anthropicKey: anthropicKeyForSettings,
      anthropicAuthToken: nativeAuth.anthropicAuthToken,
      openaiKey: openaiKeyForSettings,
      nexusProviders,
      nativeApiKeyHelper: nativeAuth.nativeApiKeyHelper,
      useApiKeySentinel: false,
      registerablePickerIds,
      selectedPickerModel: extraPickerModel ?? "",
      firerouterHeaders: bareFirerouter,
    });
    await setHarnessState(ctx.home, HARNESS.CLAUDE, {
      enabled: true,
      provider: "fireworks",
      profiles: withSavedClaudeModelMapping(snapshot.profiles, mapping),
    });
    // Drop a legacy SessionStart desktop-guard hook if present (retired; CLI-only).
    await removeDesktopGuardHook(settingsPath);
    /** @type {Array<() => void>} */
    const footnotes = [];
    const visionWarning = formatNonVisionModelsWarning(
      uniqueNonVisionModelShortIds(
        [extraPickerModel, ...Object.values(slotOverrides)]
          .filter((modelId) => modelId && !isClaudeNativeModel(modelId)),
      ),
    );
    if (visionWarning) {
      footnotes.push(() => printNote(visionWarning));
    }
    if (removedAnthropicKey) {
      footnotes.push(() => printNote(CLAUDE_ANTHROPIC_KEY_REMOVED_NOTE));
    }
    await reconcileServerToolDenials(settingsPath, preserveDeniedServerTools);
    await approveStrayAnthropicApiKey(ctx.home);
    await disableWebsearchMcp(ctx.home);
    await printHarnessOnSuccess({
      label: "Claude Code",
      // The pinned default (the `auto` mix unless the user saved a servable
      // /model pick) leads the success line, like every other harness.
      model: typeof enabledSettings?.model === "string" ? enabledSettings.model : "",
      // Show what landed in /model, like every other harness's `on` output.
      modelsAdded: registerablePickerIds,
      footnotes,
      restartHint: printClaudeModelActivationHint,
      afterConnected: async () => {
        printClaudePickerSummary({
          extraPickerModel,
          mapping,
        });
      },
    });
    printClaudeModelManagementHints();
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const [wasEnabled, settings, backup, state] = await Promise.all([
      isHarnessEnabled(ctx.home, HARNESS.CLAUDE),
      readJsonIfExists(settingsPath),
      readJsonIfExists(providerBackupPath(dataDir)),
      readJsonIfExists(providerStatePath(dataDir)),
    ]);
    const intent = claudeFireconnectIntent(settings, { backup, state });
    // A v0.8 install may have managed settings but no enabled flag or raw
    // snapshot. Reuse the on-migration fallback so upgrade-triggered off still
    // restores its values backup or strips only Nexus-owned settings.
    await prepareClaudeV09Baseline({ settingsPath, dataDir, intent });
    const connected = wasEnabled || Boolean(intent);
    await disableFireworksProvider({
      settingsPath,
      dataDir,
      wasEnabled: connected,
    });
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, false);
    await disableWebsearchMcp(ctx.home);
    await removeDesktopGuardHook(settingsPath);
    // `ctx.quiet` (uninstall) silences the per-harness narration so the
    // uninstall checklist is the only output; see `engineOff`, which gates the
    // same lines for every other harness. Non-quiet output is unchanged.
    if (!ctx.quiet) {
      printHarnessRestored("Claude Code");
      printClaudeRestartHint();
    }
    return connected ? "restored" : "none";
  },

  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath } = claudePathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    return providerStatusFromEnv(settings.env ?? {});
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    const state = await readJsonIfExists(providerStatePath(dataDir));
    const env = settings.env ?? {};
    const auth = resolveClaudeAuthState(settings, state);
    const token = auth.token;
    if (token) {
      await warmServerlessPricingCache(token);
    }
    const currentMapping = mappingFromSettings(settings);
    // Claude Code strips the managed marker when it persists a /model pick,
    // so a Fireworks-routed picker is Nexus territory with or without it.
    // Claude's own rows are not Nexus registrations and are not reported.
    const pickerIsNexusTerritory = isFireconnectModelPicker(settings.modelPicker)
      || providerStatusFromEnv(env) === "fireworks";
    const registeredModels = pickerIsNexusTerritory
      ? (settings.modelPicker?.options ?? [])
        .map((option) => option?.model)
        .filter((id) => typeof id === "string" && id.trim())
        .filter((id) => {
          const normalized = shortFireworksModelRef(normalizeModelId(id));
          return !isAnthropicModelId(normalized) && !isClaudeModelAlias(normalized);
        })
      : [];
    const payload = {
      harness: HARNESS.CLAUDE,
      provider: providerStatusFromEnv(env),
      baseUrl: env.ANTHROPIC_BASE_URL ?? null,
      hasAuthToken: auth.keyConfigured,
      authMode: auth.authMode,
      defaults: defaultClaudeModelMapping(),
      current: currentMapping,
      pricing: Object.fromEntries(
        Object.entries(currentMapping)
          .filter(([, modelId]) => modelId)
          .map(([slot, modelId]) => [slot, attachPricing(modelId)]),
      ),
      pricingNote: CLAUDE_CODE_PRICING_DISCLAIMER,
      registeredModels,
    };
    payload.keyType = "fireworks";

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    const routed = payload.provider === "fireworks";
    const mainModel = payload.current.main || payload.defaults.main || null;
    // Native main is never pinned: Claude Code's own default row is in charge,
    // and through the Fireworks gateway that resolves the bare `auto` alias —
    // so an unpinned main reads `auto`, like the other harnesses' Model line.
    const statusModel = routed && isClaudeNativeModel(mainModel) ? "auto" : mainModel;
    printStructuredHarnessStatus(HARNESS.CLAUDE, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: auth.authMode,
      endpoint: routed ? null : payload.baseUrl,
      model: statusModel,
      registeredModels,
      keySource: harnessStatusKeySource(HARNESS.CLAUDE, payload.provider, {
        authMode: auth.authMode,
      }),
    });
    if (routed && hasLegacyAnthropicMainEnv(settings)) {
      printNote(CLAUDE_LEGACY_ANTHROPIC_MODEL_WARNING);
    }
  },

  async usage(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    // Meter with live Fireworks prices, not just the static spec table. The
    // serverless catalog is per-process (no disk cache) and only `status` warmed
    // it before — so every `claude usage` / live-meter process priced from the
    // static fallback. Warm it here (self-gates on a genuine fw_ key) before any
    // cost is computed. Fully best-effort: resolving the key can throw on a
    // malformed/unreadable settings file, and usage must still work off the
    // session logs, so the whole warm is wrapped, not just the fetch.
    try {
      await warmServerlessPricingCache(await claudeResolveKey(ctx));
    } catch {
      /* fall back to static spec pricing */
    }
    if (shouldRunClaudeUsageLive(ctx)) {
      const withinDays = ctx.days || undefined;
      let session = ctx.session ?? "";
      if (!session) {
        // Needs stdin TTY for the multi-session menu; otherwise picks newest.
        session = await promptClaudeUsageSession({ home: ctx.home, withinDays });
        if (!session) {
          return;
        }
      }
      await runClaudeUsageLive({
        home: ctx.home,
        session,
        verbose: ctx.verbose,
        plain: ctx.plain,
        ...(process.env.FC_LIVE_SPLIT === "1"
          ? {}
          : {
            // The session list is always reachable, including from an explicit
            // --session. It was withheld there on the theory that you can only go
            // "back" somewhere you have been, but the list is a destination in its
            // own right: --session names a starting point, not a cage, and the only
            // way out used to be quitting and rerunning.
            promptSession: (opts) => promptClaudeUsageSession({ ...opts, withinDays }),
          }),
      });
      return;
    }
    if (ctx.lastN) {
      const reportGroup = await readClaudeUsages({ home: ctx.home, session: ctx.session ?? "", lastN: ctx.lastN });
      if (ctx.json) {
        console.log(JSON.stringify(reportGroup, null, 2));
        return;
      }
      if (!ctx.verbose && !ctx.plain && hasClaudeUsageRows(reportGroup)) {
        await playUsageIntroAnimation();
        if (canRunClaudeUsageInteractiveDisplay() && await runClaudeUsageInteractiveDisplay(reportGroup)) {
          // q/Esc/Ctrl-C resolve the display and restore the cursor, but a
          // paused TTY stdin still holds a libuv ref, so returning up the stack
          // hangs the process. Exit explicitly now that the terminal is restored
          // (same fix as the live meter's quit path in usage/live.mjs).
          process.exit(0);
        }
      }
      console.log(formatClaudeUsageReports(reportGroup, { verbose: ctx.verbose, plain: ctx.plain }));
      return;
    }

    const report = await readClaudeUsage({ home: ctx.home, session: ctx.session ?? "" });
    if (ctx.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!ctx.verbose && !ctx.plain && hasClaudeUsageRows(report)) {
      await playUsageIntroAnimation();
      if (canRunClaudeUsageInteractiveDisplay() && await runClaudeUsageInteractiveDisplay(report)) {
        // q/Esc/Ctrl-C resolve the display and restore the cursor, but a paused
        // TTY stdin still holds a libuv ref, so returning up the stack hangs the
        // process. Exit explicitly now that the terminal is restored (same fix
        // as the live meter's quit path in usage/live.mjs).
        process.exit(0);
      }
    }
    console.log(formatClaudeUsageReport(report, { verbose: ctx.verbose, plain: ctx.plain }));
  },

  async live(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    await runClaudeLiveTmux({ home: ctx.home, session: ctx.session });
  },

});
