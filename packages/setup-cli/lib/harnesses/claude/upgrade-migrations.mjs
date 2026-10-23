import { isEnabledFireworksHarness, readGlobalConfig, setHarnessState } from "../../config/global-config.mjs";
import {
  migrateLegacyClaudeModelMapping,
  savedClaudeModelMapping,
  withSavedClaudeModelMapping,
} from "./model-profile.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { loadRegisterableModels } from "../../fireworks/models.mjs";
import {
  AUTO_MODEL_ID,
  isFirerouterModelPattern,
  isRetiredModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import {
  ANTHROPIC_BYOK_HEADER,
  CLAUDE_FIREROUTER_MODEL_ENV_KEYS,
  stripCustomHeaderLines,
} from "../../firerouter/core.mjs";
import { claudeCodeModelId } from "./code-context.mjs";
import { fireworksModelDisplayFields } from "./picker-labels.mjs";
import { resolveFireworksApiKeyValue } from "../../keys/api-key.mjs";
import { disableWebsearchMcp } from "../../system/websearch-mcp.mjs";
import {
  CLAUDE_CODE_BEHAVIOR_ENV,
  providerBackupPath,
  providerStatePath,
  providerStatusFromEnv,
  resolveDataDir,
  hasPartialRetiredTelemetryOptOuts,
  retireTelemetryOptOutsOnce,
  stripLegacyAttributionHeaderLeftover,
  stripRetiredAutoModeServerPin,
  stripRetiredAutoUpdatePin,
  userSettingsPath,
} from "./core.mjs";
import {
  originalSettingsDeniedServerTools,
  reconcileGatewayServerToolDenials,
} from "./server-tools-deny.mjs";
import {
  isFireconnectModelPicker,
  withFireconnectModelPicker,
} from "./settings-model-picker.mjs";
import { resolveClaudeAuthState } from "./index.mjs";
import { isFireconnectStatusLine, withClaudeStatusLine } from "./statusline.mjs";

/**
 * Backfill one behavior key into an already-connected Claude Code install.
 * Owns every gate: the harness must be enabled and Fireworks-routed, and an
 * existing value (including a user's) is left alone.
 * @param {string} home
 * @param {keyof typeof CLAUDE_CODE_BEHAVIOR_ENV} key
 * @returns {Promise<boolean>} true when the file was updated
 */
async function backfillClaudeBehaviorKey(home, key) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return false;
  }
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  if (providerStatusFromEnv(env) !== "fireworks" || Object.hasOwn(env, key)) {
    return false;
  }
  await writeJson(
    settingsPath,
    { ...settings, env: { ...env, [key]: CLAUDE_CODE_BEHAVIOR_ENV[key] } },
    // Managed settings hold the baked Fireworks key.
    { mode: 0o600 },
  );
  return true;
}

/**
 * Add `ENABLE_TOOL_SEARCH` to an already-connected Claude Code install.
 * Installs connected before this key existed route to the Fireworks gateway
 * without it, and Claude Code turns MCP tool search off for a non-first-party
 * `ANTHROPIC_BASE_URL` unless it is set.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeToolSearchOnUpgrade(home) {
  return backfillClaudeBehaviorKey(home, "ENABLE_TOOL_SEARCH");
}

/**
 * Remove the `CLAUDE_CODE_AUTO_MODE_SERVER=0` pin an earlier upgrade or `on`
 * wrote. Pinning only kept auto mode from trying the server classifier; Claude
 * Code falls back to the local one on its own, and the pin would block the
 * server classifier once the gateway supports it.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeRetiredAutoModeServerPinOnUpgrade(home) {
  const connected = await readConnectedClaudeSettings(home);
  if (!connected) {
    return false;
  }
  const { settingsPath, settings, dataDir } = connected;
  const backup = await readJsonIfExists(providerBackupPath(dataDir));
  const { settings: next, changed } = stripRetiredAutoModeServerPin(settings, backup);
  if (!changed) {
    return false;
  }
  await writeJson(settingsPath, next, { mode: 0o600 });
  return true;
}

/**
 * Remove the `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=0` pin an earlier `on`
 * wrote, so Claude Code's own update settings apply.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeRetiredAutoUpdatePinOnUpgrade(home) {
  const connected = await readConnectedClaudeSettings(home);
  if (!connected) {
    return false;
  }
  const { settingsPath, settings, dataDir } = connected;
  const backup = await readJsonIfExists(providerBackupPath(dataDir));
  const { settings: next, changed } = stripRetiredAutoUpdatePin(settings, backup);
  if (!changed) {
    return false;
  }
  await writeJson(settingsPath, next, { mode: 0o600 });
  return true;
}

/**
 * Remove the telemetry opt-outs older versions wrote, once per install (see
 * `retireTelemetryOptOutsOnce`).
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeTelemetryOptOutsOnUpgrade(home) {
  const connected = await readConnectedClaudeSettings(home);
  if (!connected) {
    return false;
  }
  const { settingsPath, settings, dataDir } = connected;
  const statePath = providerStatePath(dataDir);
  const state = await readJsonIfExists(statePath);
  if (state.retiredTelemetryOptOuts) {
    return false;
  }
  const backup = await readJsonIfExists(providerBackupPath(dataDir));
  const { settings: next, changed } = retireTelemetryOptOutsOnce(settings, backup, state);
  if (changed) {
    await writeJson(settingsPath, next, { mode: 0o600 });
  }
  if (!changed && hasPartialRetiredTelemetryOptOuts(settings)) {
    // A partial set may be the user's own or a Nexus set they trimmed:
    // don't spend the once-only retirement on it, so a later run can
    // still act if the set is completed.
    return false;
  }
  await writeJson(statePath, { ...state, retiredTelemetryOptOuts: true });
  return changed;
}

/**
 * The user settings of a Claude Code install that is connected and still
 * Fireworks-routed, or null.
 * @param {string} home
 */
async function readConnectedClaudeSettings(home) {
  if (!home) {
    return null;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return null;
  }
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  if (providerStatusFromEnv(settings.env ?? {}) !== "fireworks") {
    return null;
  }
  return { settingsPath, settings, dataDir: resolveDataDir({ home }) };
}

/**
 * Claude Code's settings as they were before Nexus connected it, from the
 * provider backup: the raw snapshot, or the legacy per-key values. Null when
 * the backup can't tell.
 * @param {Record<string, any>} backup
 * @returns {Record<string, any> | null}
 */
function preNexusClaudeSettings(backup) {
  if (backup.snapshot !== undefined) {
    if (!backup.snapshot?.existed) return {};
    try {
      return JSON.parse(backup.snapshot.raw);
    } catch {
      return null;
    }
  }
  return backup.values !== undefined ? { env: { ...(backup.values ?? {}) } } : null;
}

/**
 * Drop an Anthropic key an earlier FireConnect copied into Claude Code's
 * settings from the environment (FireRouter-era `on`). Only a key the
 * pre-Nexus settings didn't already hold is removed, so the user's own stays,
 * and Claude Code still reads an exported ANTHROPIC_API_KEY by itself. A
 * plain re-`on` removes the same key.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeBakedAnthropicKeyOnUpgrade(home) {
  const connected = await readConnectedClaudeSettings(home);
  if (!connected) return false;
  const { settingsPath, settings, dataDir } = connected;
  const original = preNexusClaudeSettings(await readJsonIfExists(providerBackupPath(dataDir)));
  if (original === null) return false;
  const env = { ...(settings.env ?? {}) };
  let changed = false;
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim().startsWith("sk-ant-") && original.env?.[key] !== value) {
      delete env[key];
      changed = true;
    }
  }
  if (!changed) return false;
  await writeJson(settingsPath, { ...settings, env }, { mode: 0o600 });
  return true;
}

/**
 * Let the built-in Explore agent inherit the session model on an
 * already-connected Claude Code install. Installs connected before this key
 * existed run every exploration call on Opus: Explore inherits the main model
 * capped at Opus, and a Fireworks parent model fails that mapping.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeExploreInheritCapOnUpgrade(home) {
  return backfillClaudeBehaviorKey(home, "CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP");
}

/**
 * Retire the Nexus-managed WebSearch MCP now that the Messages endpoint
 * supports Claude's native WebSearch and WebFetch tools. Existing user MCPs
 * and explicit user deny rules are preserved.
 * @param {string} home
 * @returns {Promise<boolean>} true when any config was updated
 */
export async function migrateClaudeNativeWebSearchOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const mcpResult = await disableWebsearchMcp(home);
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return mcpResult.changed;
  }

  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  if (providerStatusFromEnv(settings.env ?? {}) !== "fireworks") {
    return mcpResult.changed;
  }
  const backup = await readJsonIfExists(providerBackupPath(resolveDataDir({ home })));
  const next = reconcileGatewayServerToolDenials(settings, {
    preserveDeniedTools: originalSettingsDeniedServerTools(settings, backup),
  });
  if (next === settings) {
    return mcpResult.changed;
  }
  await writeJson(settingsPath, next, { mode: 0o600 });
  return true;
}

/**
 * Re-render the managed `/model` picker rows from the live serverless catalog
 * on upgrade. `claude on` rebuilds the picker wholesale, but an already-on
 * install that only upgrades would otherwise keep last version's descriptions,
 * pricing, and catalog rows forever — this is the upgrade half of the refresh.
 *
 * Only Nexus-managed pickers are touched; a user-authored `modelPicker`
 * block is left exactly as-is (the whole point of the marker). The refresh
 * follows the same contract as re-`on`: `claude-*` rows are kept verbatim,
 * every other row is rebuilt from the catalog, and the current default plus
 * `firerouter/*` rows survive. Best-effort: no key or unreachable catalog
 * leaves the file untouched.
 *
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeModelPickerOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return false;
  }
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  if (providerStatusFromEnv(settings.env ?? {}) !== "fireworks") {
    return false;
  }
  const modelPicker = settings.modelPicker;
  if (!isFireconnectModelPicker(modelPicker)) {
    return false;
  }
  const token = resolveClaudeAuthState(settings).token
    || await resolveFireworksApiKeyValue({ home }).catch(() => "");
  if (!token) {
    return false;
  }
  const { ids } = await loadRegisterableModels({ apiKey: token });
  if (!ids.length) {
    return false;
  }
  // The refresh prunes FireRouter rows like any delisted row; the saved
  // default is protected so it survives — unless it is itself a FireRouter
  // selection, which `migrateClaudeFirerouterOnUpgrade` moves to `auto`.
  const next = withFireconnectModelPicker(settings, ids, {
    refresh: true,
    protectedIds: typeof settings.model === "string" && !isRetiredModelId(settings.model)
      ? [settings.model]
      : [],
  });
  if (next === settings) {
    return false;
  }
  await writeJson(settingsPath, next, { mode: 0o600 });
  return true;
}

/**
 * Move a connected Claude Code install off FireRouter on upgrade: the
 * top-level `/model` default and any tier-slot env pin that names a
 * FireRouter route become the `auto` mix (with its picker label fields, so
 * the slot rows don't keep FireRouter names). A legacy `ANTHROPIC_MODEL`
 * FireRouter override is removed instead: it shadows `settings.model` in
 * Claude Code, so the migrated default must not live there. Only
 * Nexus-routed installs are touched; a slot the user pinned to a concrete
 * model is left alone.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeFirerouterOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return false;
  }
  let changed = false;
  // The saved profile is what a later re-`on` would restore from, so scrub
  // its FireRouter slots here too (same mapping migration `on` applies).
  const saved = savedClaudeModelMapping(harnesses[HARNESS.CLAUDE]?.profiles);
  if (Object.keys(saved).length > 0) {
    const { mapping, changed: profileChanged } = migrateLegacyClaudeModelMapping(saved);
    if (profileChanged) {
      await setHarnessState(home, HARNESS.CLAUDE, {
        profiles: withSavedClaudeModelMapping(harnesses[HARNESS.CLAUDE]?.profiles, mapping),
      });
      changed = true;
    }
  }
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  if (providerStatusFromEnv(settings.env ?? {}) !== "fireworks") {
    return changed;
  }
  const autoTagged = shortFireworksModelRef(claudeCodeModelId(AUTO_MODEL_ID));
  const next = { ...settings };
  let settingsChanged = false;
  if (typeof settings.model === "string" && isRetiredModelId(settings.model)) {
    next.model = autoTagged;
    settingsChanged = true;
  }
  const env = { ...(settings.env ?? {}) };
  for (const key of CLAUDE_FIREROUTER_MODEL_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || !isRetiredModelId(value)) {
      continue;
    }
    if (key === "ANTHROPIC_MODEL") {
      // The legacy main env key is an override Claude Code honors over
      // settings.model, so rewriting it would shadow the migrated default
      // forever. Remove it (like `on` does) and let settings.model rule —
      // but pre-v0.9 installs used it as their *only* main default, so
      // when no usable top-level model remains, pin `auto` there instead
      // of falling back to Claude Code's native model.
      delete env[key];
      const topLevel = typeof next.model === "string" ? next.model.trim() : "";
      if (!topLevel || isRetiredModelId(topLevel)) {
        next.model = autoTagged;
      }
      settingsChanged = true;
      continue;
    }
    env[key] = autoTagged;
    // Tier slots carry picker label fields next to the model key; refresh
    // them so the row doesn't keep its FireRouter name and blurb.
    if (key !== "CLAUDE_CODE_SUBAGENT_MODEL") {
      Object.assign(env, fireworksModelDisplayFields(AUTO_MODEL_ID, key));
    }
    settingsChanged = true;
  }
  // The Anthropic key line only served the FireRouter route being dropped
  // (Claude Code's own login covers Claude turns); strip it, keeping the
  // Fireworks key, user lines, and the OpenAI key Nexus Auto reads.
  if (settingsChanged && typeof env.ANTHROPIC_CUSTOM_HEADERS === "string") {
    const stripped = stripCustomHeaderLines(env.ANTHROPIC_CUSTOM_HEADERS, [ANTHROPIC_BYOK_HEADER]);
    if (stripped !== env.ANTHROPIC_CUSTOM_HEADERS) {
      if (stripped) {
        env.ANTHROPIC_CUSTOM_HEADERS = stripped;
      } else {
        delete env.ANTHROPIC_CUSTOM_HEADERS;
      }
    }
  }
  if (!settingsChanged) {
    return changed;
  }
  next.env = env;
  await writeJson(settingsPath, next, { mode: 0o600 });
  return true;
}

/**
 * Re-point a managed status line whose helper path is stale, e.g. one still
 * under `~/.fireconnect` after the install moved to `~/.nexus`. A user's own
 * status line, or none at all, is left alone.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeStatusLinePathOnUpgrade(home) {
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  if (!isFireconnectStatusLine(settings.statusLine)) {
    return false;
  }
  const next = withClaudeStatusLine(settings);
  if (next === settings) {
    return false;
  }
  await writeJson(settingsPath, next, { mode: 0o600 });
  return true;
}

/**
 * Remove the `CLAUDE_CODE_ATTRIBUTION_HEADER=0` that FireConnect 0.7 and 0.8
 * left behind, whichever way the user upgrades.
 * @param {string} home
 * @returns {Promise<boolean>} true when a file was updated
 */
export async function migrateClaudeAttributionHeaderLeftoverOnUpgrade(home) {
  const settingsPath = userSettingsPath(home);
  const backupPath = providerBackupPath(resolveDataDir({ home }));
  const readOrEmpty = (file) => readJsonIfExists(file).catch(() => ({}));
  const { settings, backup } = stripLegacyAttributionHeaderLeftover(
    await readOrEmpty(settingsPath),
    await readOrEmpty(backupPath),
  );
  if (backup) {
    await writeJson(backupPath, backup, { mode: 0o600 });
  }
  if (settings) {
    await writeJson(settingsPath, settings, { mode: 0o600 });
  }
  return Boolean(settings || backup);
}

/** A pre-rename `apiKeyHelper` that runs the removed `~/.local/bin/fireconnect` launcher. */
const LEGACY_HELPER_LAUNCHER = /([/\\]\.local[/\\]bin[/\\])fireconnect(\.cmd)?(?=['"]?(?:\s|$))/;

/**
 * Re-point a v0.8-era `apiKeyHelper` (`~/.local/bin/fireconnect … key export`)
 * at the `nexus` launcher, since the rename removes the old one and Claude Code
 * would otherwise lose its key. A user's own helper is left alone.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeApiKeyHelperLauncherOnUpgrade(home) {
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  const helper = settings.apiKeyHelper;
  if (typeof helper !== "string" || !/(?:^|\s)key\s+export(?:\s|$)/.test(helper)) {
    return false;
  }
  const next = helper.replace(LEGACY_HELPER_LAUNCHER, "$1nexus$2");
  if (next === helper) {
    return false;
  }
  await writeJson(settingsPath, { ...settings, apiKeyHelper: next }, { mode: 0o600 });
  return true;
}
