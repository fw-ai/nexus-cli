import {
  printAzureConnected,
  printHarnessRestored,
  printHarnessUnchanged,
  printHarnessOnFootnotes,
  printHarnessOnSuccess,
} from "../cli/messages.mjs";
import { assertNotFirerouterModelId, canonicalRequestedModelId } from "../fireworks/model-id.mjs";
import { assertRequestedModelServable } from "../fireworks/model-servability.mjs";
import { resolveAzureBaseUrl, resolveAzureOnApiKey } from "../fireworks/azure-core.mjs";
import {
  resolveHarnessOnApiKey,
} from "../keys/harness-api-key.mjs";
import {
  resolveExplicitFirerouterCredential,
  resolveFirerouterByokHeaders,
  resolveFirerouterPlan,
} from "../firerouter/flag.mjs";
import {
  isHarnessEnabled,
  readGlobalConfig,
  readProviderSettings,
  setHarnessEnabled,
} from "../config/global-config.mjs";
import { nexusProvidersHeaders } from "../config/auto-providers.mjs";
import { reconcileShellEnvHook } from "../io/shell-env-hook.mjs";
import { ensureHomeForHarness } from "./context.mjs";
import { defineHarness } from "./types.mjs";
import { buildFireconnectTelemetryHeaders } from "../telemetry/request-headers.mjs";

/**
 * A HarnessProfile is the small, mostly-declarative description of a harness.
 * The engine owns the shared `on`/`off` command orchestration
 * so a new step in a flow is one edit here, not one per harness. Harness-specific
 * config-format work stays in the profile's hook functions.
 *
 * @typedef {Object} HarnessProfile
 * @property {import("./id.mjs").HarnessId} id
 * @property {string} label
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<string>} resolveKey
 *   Harness-local key (used by the registry's resolveKey and, typically, fullKey).
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<import("./types.mjs").HarnessContext>} [resolveOnContext]
 *   Resolve state-dependent defaults for `on`; the result is validated and dispatched.
 * @property {(ctx: import("./types.mjs").HarnessContext) => object} paths
 * @property {string} keyEnvRef
 * @property {import("../firerouter/flag.mjs").FirerouterCapability|null} [firerouter]
 *   Complete FireRouter capability; null/omitted means unsupported.
 * @property {boolean} [telemetryHeaders] Whether this harness can send static request headers.
 * @property {(ctx: import("./types.mjs").HarnessContext, paths: object) => Promise<Record<string,string>>} [readByokEnv]
 *   For `byok: "value"` harnesses: return a settingsEnv-shaped object (with
 *   ANTHROPIC_CUSTOM_HEADERS) built from BYOK keys already stored in the harness
 *   config, so a repeat `on` recovers them instead of dropping them.
 * @property {{
 *   read: (ctx: object, paths: object) => Promise<{ active: boolean, storedKey?: string, storedBaseUrl?: string, model?: string }>,
 *   enable: (args: { ctx: object, paths: object, apiKey: string, apiKeyFromFlag: boolean, baseUrl: string }) => Promise<{ model: string, baseUrl: string, apiKeyMode?: string }>,
 *   restart: (result: object) => void,
 * }} [azure] Complete Foundry capability; omitted means unsupported.
 * @property {(ctx: import("./types.mjs").HarnessContext, paths: object) => Promise<string>} [getExistingHarnessKey]
 * @property {(ctx: import("./types.mjs").HarnessContext, paths: object) => Promise<{ apiKeyRef?: string, effectiveKey: string, reusedExistingKey?: boolean }>} [resolveOnKey]
 *   Custom `on` key resolution (default: resolveHarnessOnApiKey with keyEnvRef + getExistingHarnessKey).
 * @property {(modelId: string) => boolean} [servedOutsideCatalog]  `--model` ids this harness
 *   serves that the serverless catalog never lists (Codex's sign-in GPT models); they skip
 *   the catalog check.
 * @property {(args: { ctx: object, paths: object, apiKeyRef: string, effectiveKey: string, modelId: string, byokHeaders: Record<string,string>, telemetryHeaders: Record<string,string>, includeFirerouter: boolean, flags: object }) => Promise<{ model: string, modelsAdded?: string[] }>} enable
 * @property {(ctx: import("./types.mjs").HarnessContext, effectiveKey: string) => Promise<void>} [envHookOn]
 * @property {(args: { ctx: object, paths: object, result: object, reusedExistingKey: boolean }) => void} [printConnected]
 *   Full success-output override (default: connected + restartHint).
 * @property {(modelId: string) => string} [displayModelId]  How the model list after
 *   `printConnected` names a model (Codex prints its FireRouter route as `firerouter`).
 * @property {() => void} [restartHint]
 * @property {(args: { ctx: object, paths: object, wasEnabled: boolean }) => Promise<"restored"|"stripped"|"unchanged">} [disable]
 * @property {(ctx: object) => Promise<void>} [prepareOff]  Stop the IDE before writing (Cursor/VS Code).
 * @property {boolean} [envHookOff]  Set false to skip the shell env-hook removal on `off` (Cursor/VS Code).
 * @property {(outcome: string) => void} [restartHintOff]
 * Command overrides — when omitted, the engine's generic implementation is used
 * (except `status`, which is always harness-specific and required):
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} status
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} [on]
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} [off]
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} [usage]
 */

/**
 * Generic `<harness> on`: resolve the key, decide the model (explicit
 * `--model` or the harness default), build BYOK headers, write the provider
 * enabled flag, reconcile the shell env hook when needed, and print the standard success
 * output. Azure mode delegates to the profile's own handler unchanged.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 */
export async function engineOn(profile, ctx) {
  ensureHomeForHarness(ctx, profile.id);

  // FireRouter routes are retired as a selection, on the Azure path too:
  // reject before any provider config is written.
  assertNotFirerouterModelId(ctx.main ?? "");

  if (profile.azure) {
    const { provider, azure: azureConfig } = await readProviderSettings(ctx.home);
    if (ctx.azure || provider === "azure") {
      await engineAzureOn(profile, ctx, azureConfig);
      return;
    }
  }

  const paths = profile.paths(ctx);
  const { apiKeyRef = "", effectiveKey, reusedExistingKey = false } = await resolveOnKey(profile, ctx, paths);

  // Admit the id before FireRouter credential setup, so a junk path cannot
  // collapse to `firerouter` or prompt for an Anthropic key.
  let modelId = canonicalRequestedModelId(ctx.main);
  let byokHeaders = {};
  let isFirerouterRequested = false;
  let preResolvedAnthropicKey;
  if (profile.firerouter) {
    const plan = resolveFirerouterPlan({ ...ctx, main: modelId });
    modelId = plan.mainModel;
    isFirerouterRequested = plan.isFirerouter;
    const settingsEnv = profile.readByokEnv ? await profile.readByokEnv(ctx, paths) : {};
    // Direct Fireworks gateway `on` only (Azure returns above).
    // Harnesses that cannot forward a key (`byok: "none"`) skip credential
    // resolution entirely: they connect without BYOK headers and FireRouter
    // routes the Fireworks mix.
    const needsCredential = profile.firerouter.byok !== "none"
      && plan.requiresAnthropicKey;
    if (needsCredential) {
      ({ anthropicKey: preResolvedAnthropicKey } = await resolveExplicitFirerouterCredential({
        firerouter: profile.firerouter,
        ctx,
        settingsEnv,
      }));
    }
    // FireRouter registers only when explicitly requested (`--model firerouter...`).
    const catalogFirerouter = isFirerouterRequested && profile.firerouter.catalogByok === true;
    if (profile.firerouter.byok === "value") {
      // Recover BYOK keys that live only in the harness's existing config
      // headers, so a repeat `on` without re-supplying them doesn't drop them.
      // VS Code alone uses catalogByok: firerouter BYOK belongs on the model
      // entry, not the provider (OpenCode/Pi attach at provider level).
      byokHeaders = await resolveFirerouterByokHeaders({
        plan,
        catalogFirerouter,
        ctx,
        settingsEnv,
        preResolvedAnthropicKey,
      });
    }
  }

  if (!profile.servedOutsideCatalog?.(modelId)) {
    await assertRequestedModelServable(modelId, { apiKey: effectiveKey });
  }

  // The `auto` router's provider scope (`nexus auto`) is a static header
  // like telemetry: it rides whichever header channel the harness has
  // (BYOK headers for value harnesses, telemetry headers for the rest).
  // The gateway honors it only for `auto`, so it is safe on the provider
  // for in-session model switching. Unset = no header (default scope).
  const autoHeaders = nexusProvidersHeaders(
    (await readGlobalConfig(ctx.home)).auto.providers,
  );
  const result = await profile.enable({
    ctx,
    paths,
    apiKeyRef,
    effectiveKey,
    modelId,
    byokHeaders: { ...byokHeaders, ...autoHeaders },
    telemetryHeaders: profile.telemetryHeaders
      ? { ...buildFireconnectTelemetryHeaders(profile.id), ...autoHeaders }
      : {},
    includeFirerouter: isFirerouterRequested,
  });

  await setHarnessEnabled(ctx.home, profile.id, true, "fireworks");
  if (profile.envHookOn) {
    await profile.envHookOn(ctx, effectiveKey);
  }
  // An upgrade's re-`on` reports through its own note.
  if (ctx.quiet) {
    return;
  }

  const modelsAdded = result.modelsAdded ?? [result.model];
  if (profile.printConnected) {
    await profile.printConnected({ ctx, paths, result, reusedExistingKey });
    const displayModelId = profile.displayModelId ?? ((model) => model);
    printHarnessOnFootnotes(modelsAdded.map(displayModelId), [], profile.restartHint, {
      primaryModel: displayModelId(result.model),
    });
    return;
  }
  await printHarnessOnSuccess({
    label: profile.label,
    model: result.model,
    modelsAdded,
    restartHint: profile.restartHint,
  });
}

/**
 * Generic `<harness> on --azure`: the shared Foundry (Azure) orchestration —
 * resolve the key + endpoint (precedence: flag > configured > stored > env),
 * write the provider through the profile's cohesive Azure capability, flip the
 * enabled flag, and print the standard Azure success output.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 * @param {{ baseUrl?: string, apiKey?: string }} azureConfig
 */
export async function engineAzureOn(profile, ctx, azureConfig) {
  const paths = profile.paths(ctx);
  const { active = false, storedKey = "", storedBaseUrl = "" } = await profile.azure.read(ctx, paths);

  const { apiKey, apiKeyFromFlag } = await resolveAzureOnApiKey({
    apiKey: ctx.apiKey,
    apiKeyFromFlag: ctx.apiKeyFromFlag,
    configuredApiKey: azureConfig.apiKey,
    getExistingKey: async () => (active ? storedKey : ""),
  });
  const baseUrl = resolveAzureBaseUrl(ctx, azureConfig, active ? storedBaseUrl : "");

  const result = await profile.azure.enable({ ctx, paths, apiKey, apiKeyFromFlag, baseUrl });

  await setHarnessEnabled(ctx.home, profile.id, true, "azure");
  await reconcileShellEnvHook(ctx.home);

  printAzureConnected({
    id: profile.label,
    result,
  });
  profile.azure.restart(result);
}

/**
 * `on` key resolution: the profile's own resolver when provided (Cursor/VS Code
 * read a SQLite secret), else the standard keychain/env-ref flow.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 * @param {object} paths
 */
async function resolveOnKey(profile, ctx, paths) {
  if (profile.resolveOnKey) {
    return profile.resolveOnKey(ctx, paths);
  }
  const { apiKey, effectiveKey, reusedExistingKey } = await resolveHarnessOnApiKey({
    apiKey: ctx.apiKey,
    home: ctx.home,
    harnessEnvRef: profile.keyEnvRef,
    getExistingHarnessKey: profile.getExistingHarnessKey
      ? () => profile.getExistingHarnessKey(ctx, paths)
      : undefined,
  });
  return { apiKeyRef: apiKey, effectiveKey, reusedExistingKey };
}

/**
 * Is this harness currently routed through Fireworks/Azure?
 *
 * The harness's own config is the source of truth: `providerStatus` reads it
 * directly, so it reflects reality even when Nexus's `enabled` flag has
 * drifted (older CLI versions, adapters that didn't maintain it, a lost or
 * reinstalled `~/.nexus`). The flag is only a fallback for when that
 * config cannot be read at all.
 *
 * This is the single definition of "on" — `off` uses it to choose
 * restore-vs-strip, and `uninstall` uses it to decide which harnesses to
 * restore at all, so the two can never disagree about a harness's state.
 *
 * Named for the real condition rather than the flag: `isHarnessEnabled` reads
 * the flag, this reads the config, and the gap between them is the whole point.
 *
 * @param {{ id: string, providerStatus?: (ctx: object) => Promise<string> }} target
 *   a harness profile or adapter; both expose `id` and optional `providerStatus`.
 * @param {import("./types.mjs").HarnessContext} ctx
 * @returns {Promise<boolean>}
 */
export async function isHarnessRouted(target, ctx) {
  if (typeof target.providerStatus === "function") {
    try {
      const provider = await target.providerStatus(ctx);
      return provider === "fireworks" || provider === "azure";
    } catch {
      // Config unreadable (e.g. IDE DB locked): fall back to the flag below.
    }
  }
  return isHarnessEnabled(ctx.home, target.id);
}

/**
 * Generic `<harness> off`: back out the provider config via the profile's
 * `disable` hook (which returns an outcome), flip the enabled flag, remove the
 * shell env hook (unless the harness opts out), and print restored/unchanged.
 * `prepareOff` (stop the IDE) and `restartHintOff` are optional.
 *
 * Pass `ctx.quiet` to suppress the restored/unchanged + restart-hint narration
 * (see below); the outcome is returned either way so a caller that silences the
 * narration can still report what happened.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 * @returns {Promise<"restored" | "stripped" | "none">}
 */
export async function engineOff(profile, ctx) {
  ensureHomeForHarness(ctx, profile.id);
  const paths = profile.paths(ctx);
  // `wasEnabled` drives restore-vs-strip in `profile.disable`.
  const wasEnabled = await isHarnessRouted(profile, ctx);
  if (profile.prepareOff) {
    await profile.prepareOff(ctx);
  }
  const outcome = await profile.disable({ ctx, paths, wasEnabled });
  await setHarnessEnabled(ctx.home, profile.id, false);
  if (profile.envHookOff !== false) {
    await reconcileShellEnvHook(ctx.home);
  }
  // `ctx.quiet` suppresses the per-harness narration. Used by `uninstall`,
  // which restores every harness in one run and prints its own checklist plus a
  // single restart reminder — the per-harness lines would both duplicate that
  // and interleave with it.
  if (!ctx.quiet) {
    if (outcome === "restored" || outcome === "stripped") {
      printHarnessRestored(profile.id);
    } else {
      printHarnessUnchanged(profile.id);
    }
    if (profile.restartHintOff) {
      profile.restartHintOff(outcome);
    }
  }
  return outcome;
}

function assertProfileCapabilities(profile) {
  const capability = profile.firerouter;
  if (capability != null) {
    const validByok = typeof capability === "object"
      && (
        capability.byok === "none"
        || capability.byok === "value"
      );
    if (!validByok || typeof capability.autoCatalog !== "boolean") {
      throw new Error(
        `Harness profile ${profile.id} must define firerouter as `
          + "{ byok: \"none\"|\"value\", autoCatalog: boolean, catalogByok?: boolean } or null.",
      );
    }
    if (
      Object.hasOwn(capability, "catalogByok")
      && typeof capability.catalogByok !== "boolean"
    ) {
      throw new Error(
        `Harness profile ${profile.id} firerouter.catalogByok must be a boolean when set.`,
      );
    }
  }
  if (
    profile.azure != null
    && (
      typeof profile.azure !== "object"
      || typeof profile.azure.read !== "function"
      || typeof profile.azure.enable !== "function"
      || typeof profile.azure.restart !== "function"
    )
  ) {
    throw new Error(
      `Harness profile ${profile.id} must define azure as { read, enable, restart } or omit it.`,
    );
  }
}

/**
 * Build a HarnessAdapter from a HarnessProfile.
 * @param {HarnessProfile} profile
 * @returns {import("./types.mjs").HarnessAdapter}
 */
export function defineHarnessProfile(profile) {
  assertProfileCapabilities(profile);
  return defineHarness({
    id: profile.id,
    label: profile.label,
    resolveKey: profile.resolveKey,
    firerouter: profile.firerouter ?? null,
    azure: profile.azure ?? null,
    // Engine supplies the default flow; a profile may override when needed.
    on: profile.on ?? ((ctx) => engineOn(profile, ctx)),
    off: profile.off ?? ((ctx) => engineOff(profile, ctx)),
    status: profile.status,
    ...(profile.providerStatus ? { providerStatus: profile.providerStatus } : {}),
    ...(profile.usage ? { usage: profile.usage } : {}),
    ...(profile.live ? { live: profile.live } : {}),
    ...(profile.resolveOnContext ? { resolveOnContext: profile.resolveOnContext } : {}),
  });
}
