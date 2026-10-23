import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";

import {
  applyClaudeCodeContextPolicy,
  claudeCodeModelId,
  ensureCatalogForClaudeCodeContext,
  stripClaudeCodeContextSuffix,
} from "./code-context.mjs";
import {
  buildClaudeCustomHeaders,
  customHeaderValue,
  fireworksKeyFromCustomHeaders,
  NEXUS_PROVIDERS_HEADER,
  OPENAI_BYOK_HEADER,
  openaiKeyFromCustomHeaders,
  setFireworksKeyInCustomHeaders,
  stripFireworksKeyFromCustomHeaders,
  stripFirerouterOwnedEnv,
  stripManagedCustomHeaderLines,
} from "../../firerouter/core.mjs";
import {
  AUTO_MODEL_ID,
  CLAUDE_NATIVE_MODEL_ID,
  DEEPSEEK_FLASH_LATEST_ROUTER_ID,
  FIREWORKS_BASE_URL,
  GLM_FAST_LATEST_ROUTER_ID,
  isClaudeModelAlias,
  isClaudeNativeModel,
  isFirerouterModelPattern,
  isRetiredModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import {
  fireworksKeyOrEmpty,
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import {
  buildFireconnectTelemetryHeaders,
  mergeFireconnectTelemetryHeaderLines,
  stripFireconnectTelemetryHeaderLines,
} from "../../telemetry/request-headers.mjs";
import {
  defaultClaudeModelMapping,
  resolveClaudeModelMapping,
} from "./model-profile.mjs";
import { stripClaudeStatusLine, withClaudeStatusLine } from "./statusline.mjs";
import {
  buildFireconnectModelPickerOptions,
  isFireconnectModelPicker,
  stripFireconnectModelPicker,
  withFireconnectModelPicker,
} from "./settings-model-picker.mjs";
import { fireworksModelDisplayFields } from "./picker-labels.mjs";

export const DEFAULT_DATA_DIR = ".nexus/claude";
export const USER_SETTINGS_RELATIVE_PATH = ".claude/settings.json";

/** Legacy main-default env keys stripped when writing Nexus-managed settings. */
const LEGACY_ANTHROPIC_MAIN_ENV_KEYS = ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];

export const FIREWORKS_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // Legacy main default; kept so off/restore paths can strip pre-v0.9 installs.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  // Retired: older versions pinned this to "0". Still listed so every Nexus
  // strip path removes it.
  "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE",
  // Retired: older versions set these to "1". Still listed so every Nexus
  // strip path removes them.
  "DISABLE_TELEMETRY",
  "DO_NOT_TRACK",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "ENABLE_TOOL_SEARCH",
  // Retired: older versions pinned this to "0". Still listed so every
  // Nexus strip path removes it.
  "CLAUDE_CODE_AUTO_MODE_SERVER",
  // The built-in Explore agent inherits the main model capped at Opus, which
  // strands Fireworks-routed sessions on Opus for every exploration call.
  // Disabling the cap lets Explore use the session model verbatim.
  "CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP",
];

/** Env keys that steer Claude Code client-side model selection. */
export const MODEL_MAPPING_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
];

/** Claude Code behavior tuning shared by direct and router modes (not model mapping). */
export const CLAUDE_CODE_BEHAVIOR_ENV = {
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
  // Claude Code disables MCP tool search when ANTHROPIC_BASE_URL is not
  // api.anthropic.com. Force it on so deferred tool_reference loading still
  // works through the Fireworks gateway.
  ENABLE_TOOL_SEARCH: "true",
  // The built-in Explore agent inherits the session model capped at Opus;
  // a Fireworks parent model fails that mapping and lands on Opus, so every
  // exploration call bills at Opus rates. Removing the cap keeps Explore on
  // the session model (undocumented, verified against Claude Code v2.1.278).
  CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: "1",
};

export const DEFAULT_FIREWORKS_PRESET = {
  ...CLAUDE_CODE_BEHAVIOR_ENV,
};

export function resolveDataDir({ home, dataDir = "" }) {
  if (dataDir) {
    return dataDir;
  }

  return path.join(home, DEFAULT_DATA_DIR);
}

export function userSettingsPath(home, settingsPath = "") {
  if (settingsPath) {
    return settingsPath;
  }
  return path.join(home, USER_SETTINGS_RELATIVE_PATH);
}

export function providerBackupPath(dataDir) {
  return path.join(dataDir, "provider-backup.json");
}

export function providerStatePath(dataDir) {
  return path.join(dataDir, "provider-state.json");
}

function stripMappedModelId(value) {
  return value ? stripClaudeCodeContextSuffix(value) : value;
}

/**
 * Read the active Claude Code slot mapping from settings on disk. Main uses the
 * top-level `model` field (where `/model` persists); legacy installs may still
 * have `env.ANTHROPIC_MODEL`, which is honored as a fallback until
 * `nexus claude` strips it.
 *
 * @param {{ model?: string, env?: Record<string, string> }} settings
 */
export function mappingFromSettings(settings = {}) {
  const env = settings.env ?? {};
  const mainFromModel = typeof settings.model === "string" && settings.model.trim()
    ? stripMappedModelId(settings.model.trim())
    : null;
  // A bare Claude Code `/model` picker alias (opus/sonnet/haiku/fable) names no
  // concrete model: it resolves at request time through the alias's own env slot,
  // which the slot rows below already report. Treat it as unpinned (native) main
  // instead of misreading the user's picker choice as a Nexus model pin.
  const mainAliasPicked = isClaudeModelAlias(mainFromModel);
  const mainFromEnv = env.ANTHROPIC_MODEL
    ? stripMappedModelId(env.ANTHROPIC_MODEL)
    : null;
  const routed = providerStatusFromEnv(env) === "fireworks";
  // A routed install with an unset alias slot means "use Claude's own default
  // (Anthropic) model". Unset pins surface as the native sentinel so live reads
  // agree with what `on` persisted.
  const native = routed ? CLAUDE_NATIVE_MODEL_ID : null;
  const resolvedMain = (mainFromModel && !mainAliasPicked ? mainFromModel : null) || mainFromEnv;
  return {
    main: resolvedMain || native,
    opus: stripMappedModelId(env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null) || native,
    sonnet: stripMappedModelId(env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null) || native,
    haiku: stripMappedModelId(env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null) || native,
    fable: stripMappedModelId(env.ANTHROPIC_DEFAULT_FABLE_MODEL ?? null) || native,
    subagent: stripMappedModelId(env.CLAUDE_CODE_SUBAGENT_MODEL ?? null) || native,
  };
}

function withoutLegacyAnthropicMainEnv(env = {}) {
  if (!env.ANTHROPIC_MODEL && !env.ANTHROPIC_SMALL_FAST_MODEL) {
    return env;
  }
  const next = { ...env };
  for (const key of LEGACY_ANTHROPIC_MAIN_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

/**
 * Return true when Nexus-routed settings still carry the legacy main env key
 * that overrides Claude Code's top-level `model` field (including `/model` picks).
 *
 * @param {{ env?: Record<string, string> }} settings
 */
export function hasLegacyAnthropicMainEnv(settings = {}) {
  const env = settings.env ?? {};
  return Boolean(
    (env.ANTHROPIC_MODEL || env.ANTHROPIC_SMALL_FAST_MODEL)
    && providerStatusFromEnv(env) === "fireworks",
  );
}

export function fireworksHostnameFromBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return "";
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "fireworks.ai" || hostname.endsWith(".fireworks.ai")
      ? hostname
      : "";
  } catch {
    return "";
  }
}

/**
 * Recover active Nexus intent from current settings. A Fireworks
 * hostname is not sufficient by itself: backup/state, a managed helper/header,
 * telemetry, or Nexus's model mapping must also identify ownership.
 */
export function claudeFireconnectIntent(settings, { backup = {}, state = {} } = {}) {
  const env = settings.env ?? {};
  const hostname = fireworksHostnameFromBaseUrl(env.ANTHROPIC_BASE_URL);
  if (!hostname) {
    return null;
  }

  const mapping = mappingFromSettings(settings);
  const headers = env.ANTHROPIC_CUSTOM_HEADERS;
  const hasFireworksMapping = Object.values(mapping).some(Boolean);
  const hasTelemetry = typeof headers === "string"
    && stripFireconnectTelemetryHeaderLines(headers) !== headers;
  const hasCurrentManagedHeader = isFireworksShapedKey(
    fireworksKeyFromCustomHeaders(headers),
  ) && hasFireworksMapping;
  const hasManagedEvidence = backup.snapshot !== undefined
    || backup.values !== undefined
    || Boolean(state.authMode || state.managedApiKeyHelper)
    || stripManagedApiKeyHelper(settings, state).changed
    || env.ANTHROPIC_API_KEY === "fireconnect"
    || hasTelemetry
    || hasCurrentManagedHeader;
  if (!hasManagedEvidence) {
    return null;
  }

  return {
    hostname,
    mode: "direct",
    mapping,
    needsUpgrade: backup.snapshot === undefined,
  };
}

export function providerStatusFromEnv(env) {
  if (env.ANTHROPIC_BASE_URL === FIREWORKS_BASE_URL) {
    return "fireworks";
  }
  if (env.ANTHROPIC_BASE_URL) {
    return "custom";
  }
  return "default";
}

/**
 * Raw-text snapshot of a settings file (not parsed JSON) so `off` can restore it
 * byte-for-byte, preserving the user's formatting and key order — the same
 * approach the other harnesses use.
 * @param {string} filePath
 * @returns {Promise<{ existed: boolean, raw: string }>}
 */
export async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { existed: false, raw: "" };
    }
    throw error;
  }
}

/**
 * Snapshot the settings file at `settingsPath` into `backupPath` as raw text,
 * recording the absolute path it was taken for. Owner-private (0600 file in a
 * 0700 dir) since the settings can hold credentials.
 * @param {{ settingsPath: string, backupPath: string }} opts
 * @returns {Promise<{ configPath: string, snapshot: { existed: boolean, raw: string } }>} the backup written
 */
export async function writeSettingsSnapshotBackup({ settingsPath, backupPath }) {
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  const snapshot = await readRawIfExists(settingsPath);
  const backup = { configPath: path.resolve(settingsPath), snapshot };
  await writeJson(backupPath, backup, { mode: 0o600 });
  return backup;
}

/**
 * Restore a raw settings snapshot byte-for-byte (or delete the file when it
 * didn't exist), then remove the backup. Returns false when `backup` isn't a
 * raw snapshot (caller falls back to a legacy/surgical path). Refuses to restore
 * a snapshot taken for a different file.
 * @param {{ settingsPath: string, backupPath: string, backup: any }} opts
 * @returns {Promise<boolean>}
 */
export async function restoreSettingsSnapshotBackup({ settingsPath, backupPath, backup }) {
  if (!backup || backup.snapshot === undefined) {
    return false;
  }
  if (backup.configPath !== undefined && backup.configPath !== path.resolve(settingsPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${settingsPath}; refusing to restore.`,
    );
  }
  if (backup.snapshot.existed) {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileAtomic(settingsPath, backup.snapshot.raw);
  } else {
    await unlink(settingsPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await unlink(backupPath).catch(() => {});
  return true;
}

export function claudeFireworksKeyFrom({ env = {} } = {}) {
  return fireworksKeyOrEmpty(env.ANTHROPIC_API_KEY)
    || fireworksKeyOrEmpty(env.ANTHROPIC_AUTH_TOKEN)
    // Direct mode stores the key in the X-Fireworks-Api-Key custom header.
    || fireworksKeyOrEmpty(fireworksKeyFromCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS));
}

export function applyTopLevelBackup(settings, topLevelBackup) {
  const next = { ...settings };
  if (!topLevelBackup?.values) {
    return next;
  }

  for (const [key, value] of Object.entries(topLevelBackup.values)) {
    next[key] = value;
  }
  for (const key of topLevelBackup.missing ?? []) {
    delete next[key];
  }
  return next;
}

export function clearFireworksTopLevelWithoutBackup(settings) {
  let next = { ...settings };
  if (Object.hasOwn(next, "model")) {
    delete next.model;
  }
  ({ settings: next } = stripFireconnectModelPicker(next));
  return next;
}

/**
 * Remove Nexus-managed apiKeyHelper after disable. Returns
 * { settings, changed } like the sibling strip helpers (stripFireworksOwnedEnv,
 * stripModelMappingEnv) so callers don't have to compare apiKeyHelper before
 * and after to detect a change.
 * @param {Record<string, unknown>} settings
 * @param {{ authMode?: string, managedApiKeyHelper?: string }} state
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 */
export function stripManagedApiKeyHelper(settings, state = {}) {
  if (!Object.hasOwn(settings, "apiKeyHelper")) {
    return { settings, changed: false };
  }

  const managedHelper = state.managedApiKeyHelper;
  const currentHelper = settings.apiKeyHelper;
  const isRecordedHelper = Boolean(managedHelper) && currentHelper === managedHelper;
  const isLegacyFireconnectHelper = typeof currentHelper === "string"
    && /(?:^|[/\\])(?:fireconnect|nexus)(?:\.mjs|\.cmd)?['"]?(?:\s|$)/.test(currentHelper)
    && /(?:^|\s)key\s+export(?:\s|$)/.test(currentHelper);
  // authMode describes the prior Nexus configuration, not ownership of
  // a helper that may just have been restored from the user's backup.
  if (isRecordedHelper || isLegacyFireconnectHelper) {
    const next = { ...settings };
    delete next.apiKeyHelper;
    return { settings: next, changed: true };
  }

  return { settings, changed: false };
}

/**
 * Construct the safest baseline possible when upgrading a managed legacy
 * configuration that has no backup. The caller must establish ownership with
 * claudeFireconnectIntent before using this destructive strip.
 */
export function stripFireconnectManagedClaudeSettings(settings, state = {}) {
  const nextEnv = { ...(settings.env ?? {}) };
  for (const key of FIREWORKS_ENV_KEYS) {
    delete nextEnv[key];
  }
  if (typeof nextEnv.ANTHROPIC_CUSTOM_HEADERS === "string") {
    const headers = stripManagedCustomHeaderLines(nextEnv.ANTHROPIC_CUSTOM_HEADERS);
    if (headers) {
      nextEnv.ANTHROPIC_CUSTOM_HEADERS = headers;
    } else {
      delete nextEnv.ANTHROPIC_CUSTOM_HEADERS;
    }
  }

  let nextSettings = { ...settings, env: nextEnv };
  nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
  nextSettings = stripClaudeStatusLine(nextSettings).settings;
  ({ settings: nextSettings } = stripFireconnectModelPicker(nextSettings));
  return stripManagedApiKeyHelper(nextSettings, state).settings;
}

function isFireworksOwnedEnvEntry(key, value, env) {
  if (key === "ANTHROPIC_BASE_URL") {
    return value === FIREWORKS_BASE_URL;
  }
  if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") {
    return isFireworksShapedKey(value);
  }
  if (env.ANTHROPIC_BASE_URL === FIREWORKS_BASE_URL) {
    return true;
  }
  return false;
}

/**
 * Remove only env entries Nexus owns — never strip user Anthropic keys.
 * @param {Record<string, string>} env
 */
export function stripFireworksOwnedEnv(env) {
  const nextEnv = { ...env };
  let changed = false;
  for (const key of FIREWORKS_ENV_KEYS) {
    if (!Object.hasOwn(nextEnv, key)) {
      continue;
    }
    if (isFireworksOwnedEnvEntry(key, nextEnv[key], env)) {
      delete nextEnv[key];
      changed = true;
    }
  }
  // Direct mode authenticates via an X-Fireworks-Api-Key line in
  // ANTHROPIC_CUSTOM_HEADERS (not one of FIREWORKS_ENV_KEYS); strip every
  // Nexus-managed line (Fireworks key, BYOK provider keys, provider scope,
  // telemetry) so `off` never leaves a live key behind for Claude Code to
  // send to Anthropic, preserving any user lines.
  if (typeof nextEnv.ANTHROPIC_CUSTOM_HEADERS === "string") {
    const stripped = stripManagedCustomHeaderLines(nextEnv.ANTHROPIC_CUSTOM_HEADERS);
    if (stripped !== nextEnv.ANTHROPIC_CUSTOM_HEADERS) {
      if (stripped) {
        nextEnv.ANTHROPIC_CUSTOM_HEADERS = stripped;
      } else {
        delete nextEnv.ANTHROPIC_CUSTOM_HEADERS;
      }
      changed = true;
    }
  }
  return { env: nextEnv, changed };
}

function preFireconnectEnv(backup = {}) {
  if (backup.snapshot === undefined) {
    return backup.values ?? {};
  }
  if (!backup.snapshot.existed) {
    return {};
  }
  try {
    return JSON.parse(backup.snapshot.raw)?.env ?? {};
  } catch {
    return {};
  }
}

/**
 * Undo env values an older Nexus wrote. A key that still holds the value
 * Nexus wrote goes back to its pre-Nexus value, or is removed if the user's
 * settings didn't have it.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} backup provider backup (raw snapshot or legacy values)
 * @param {Record<string, string>} pins key → the value Nexus wrote
 * @returns {{ settings: Record<string, any>, changed: boolean }}
 */
function stripRetiredEnvPins(settings, backup, pins) {
  const env = settings.env ?? {};
  const original = preFireconnectEnv(backup);
  const keys = Object.keys(pins).filter((key) => env[key] === pins[key] && original[key] !== pins[key]);
  if (keys.length === 0) {
    return { settings, changed: false };
  }
  const nextEnv = { ...env };
  for (const key of keys) {
    if (Object.hasOwn(original, key)) {
      nextEnv[key] = original[key];
    } else {
      delete nextEnv[key];
    }
  }
  return { settings: { ...settings, env: nextEnv }, changed: true };
}

/**
 * Drop the `CLAUDE_CODE_AUTO_MODE_SERVER=0` pin older versions wrote. Claude
 * Code already falls back to its local classifier when the gateway rejects the
 * server-side request, and the pin would keep blocking the server classifier
 * once the gateway supports it. A "0" in the pre-Nexus settings is the
 * user's own and stays.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} [backup] provider backup (raw snapshot or legacy values)
 * @returns {{ settings: Record<string, any>, changed: boolean }}
 */
export function stripRetiredAutoModeServerPin(settings, backup = {}) {
  return stripRetiredEnvPins(settings, backup, { CLAUDE_CODE_AUTO_MODE_SERVER: "0" });
}

/**
 * Drop the `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=0` pin older versions
 * wrote. Nexus leaves Claude Code's own update settings alone. A "0" in the
 * pre-Nexus settings is the user's own and stays.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} [backup] provider backup (raw snapshot or legacy values)
 * @returns {{ settings: Record<string, any>, changed: boolean }}
 */
export function stripRetiredAutoUpdatePin(settings, backup = {}) {
  return stripRetiredEnvPins(settings, backup, { CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "0" });
}

/**
 * Telemetry opt-outs older versions wrote. Each one also stops Claude Code
 * from fetching its feature flags, and without them it hides flag-gated tools
 * such as Artifact. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` hides Artifact
 * on its own as well.
 */
const RETIRED_TELEMETRY_OPT_OUTS = {
  DISABLE_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/**
 * Drop the telemetry opt-outs older versions wrote, once per install: callers
 * then set `retiredTelemetryOptOuts` in provider state, so an opt-out the user
 * adds later stays. Values from the pre-Nexus settings stay too.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} backup provider backup (raw snapshot or legacy values)
 * @param {Record<string, any>} state provider state
 * @returns {{ settings: Record<string, any>, changed: boolean }}
 */
/**
 * True when some but not all of the Nexus-written telemetry opt-outs
 * are present: a partial set the upgrade must not consume its
 * once-only retirement on, so a later run can still act if the set
 * is completed or removed.
 * @param {Record<string, any>} settings
 */
export function hasPartialRetiredTelemetryOptOuts(settings) {
  const env = settings.env ?? {};
  const present = Object.entries(RETIRED_TELEMETRY_OPT_OUTS)
    .filter(([key, value]) => env[key] === value);
  return present.length > 0 && present.length < Object.keys(RETIRED_TELEMETRY_OPT_OUTS).length;
}

export function retireTelemetryOptOutsOnce(settings, backup, state) {
  if (state.retiredTelemetryOptOuts) {
    return { settings, changed: false };
  }
  // Nexus always wrote the three opt-outs together (CLAUDE_CODE_BEHAVIOR_ENV).
  // A lone opt-out (e.g. only DISABLE_TELEMETRY=1) is the user's own deliberate
  // setting added after `on`, so only the full Nexus-written set is retired;
  // a partial set stays, and the upgrade note tells the user so.
  const env = settings.env ?? {};
  const fullNexusSet = Object.entries(RETIRED_TELEMETRY_OPT_OUTS)
    .every(([key, value]) => env[key] === value);
  if (!fullNexusSet) {
    return { settings, changed: false };
  }
  return stripRetiredEnvPins(settings, backup, RETIRED_TELEMETRY_OPT_OUTS);
}

const LEGACY_ATTRIBUTION_HEADER_LEFTOVER = "0";

function withoutAttributionHeaderLeftover(settings) {
  const env = settings?.env;
  if (!env || typeof env !== "object" || env.CLAUDE_CODE_ATTRIBUTION_HEADER !== LEGACY_ATTRIBUTION_HEADER_LEFTOVER) {
    return null;
  }
  const nextEnv = { ...env };
  delete nextEnv.CLAUDE_CODE_ATTRIBUTION_HEADER;
  const next = { ...settings, env: nextEnv };
  if (Object.keys(nextEnv).length === 0) {
    delete next.env;
  }
  return next;
}

/**
 * FireConnect 0.7 and 0.8 set `CLAUDE_CODE_ATTRIBUTION_HEADER=0` on `claude on`
 * and their `claude off` never removed it. Left behind it disables Claude
 * Code's attribution block, which breaks auto mode, and a later `on` snapshots
 * it so `off` would put it back. Removes only that exact value, from the live
 * settings and from a saved provider backup.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} [backup] provider backup (raw snapshot or legacy values)
 * @returns {{ settings: Record<string, any> | null, backup: Record<string, any> | null }} the changed objects, or null
 */
export function stripLegacyAttributionHeaderLeftover(settings, backup = {}) {
  const nextSettings = withoutAttributionHeaderLeftover(settings);
  let nextBackup = null;
  if (backup.snapshot?.existed) {
    let snapshotSettings;
    try {
      snapshotSettings = JSON.parse(backup.snapshot.raw);
    } catch {
      snapshotSettings = null;
    }
    const cleaned = withoutAttributionHeaderLeftover(snapshotSettings);
    if (cleaned) {
      nextBackup = { ...backup, snapshot: { ...backup.snapshot, raw: `${JSON.stringify(cleaned, null, 2)}\n` } };
    }
  } else if (backup.snapshot === undefined
      && backup.values?.CLAUDE_CODE_ATTRIBUTION_HEADER === LEGACY_ATTRIBUTION_HEADER_LEFTOVER) {
    const values = { ...backup.values };
    delete values.CLAUDE_CODE_ATTRIBUTION_HEADER;
    const missing = [...new Set([...(backup.missing ?? []), "CLAUDE_CODE_ATTRIBUTION_HEADER"])];
    nextBackup = { ...backup, values, missing };
  }
  return { settings: nextSettings, backup: nextBackup };
}

/**
 * Remove client-side model mapping env entries (for FireRouter server-side routing).
 * @param {Record<string, string>} env
 */
export function stripModelMappingEnv(env) {
  const nextEnv = { ...env };
  let changed = false;
  for (const key of MODEL_MAPPING_ENV_KEYS) {
    if (Object.hasOwn(nextEnv, key)) {
      delete nextEnv[key];
      changed = true;
    }
  }
  return { env: nextEnv, changed };
}

/** Env keys for the extra /model picker row; not set (main uses top-level `model`). */
const CUSTOM_MODEL_OPTION_ENV_KEYS = [
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
];

export function stripCustomModelOptionEnv(env) {
  const nextEnv = { ...env };
  for (const key of CUSTOM_MODEL_OPTION_ENV_KEYS) {
    delete nextEnv[key];
  }
  return nextEnv;
}

/** Subscription picker labels for pinned alias slots. */
export function syncFireworksModelDisplay(env, mapping) {
  const fields = {};
  for (const [slot, prefix] of [
    ["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
    ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
    ["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
    ["fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"],
  ]) {
    if (!isClaudeNativeModel(mapping[slot])) {
      Object.assign(fields, fireworksModelDisplayFields(mapping[slot], prefix));
    }
  }
  return stripCustomModelOptionEnv({ ...env, ...fields });
}

const SLOT_MODEL_ENV_KEY = Object.freeze({
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  subagent: "CLAUDE_CODE_SUBAGENT_MODEL",
});

function envKeysToClearForNativeSlot(slot) {
  const key = SLOT_MODEL_ENV_KEY[slot];
  if (!key) {
    return [];
  }
  return slot === "subagent"
    ? [key]
    : [key, `${key}_NAME`, `${key}_DESCRIPTION`];
}

export function modelEnvFromMapping(mapping) {
  const merged = {};
  for (const [slot, modelId] of Object.entries(mapping)) {
    if (modelId == null || isClaudeNativeModel(modelId)) {
      continue; // native/unset slots pin nothing (main uses top-level `model`)
    }
    const envKey = SLOT_MODEL_ENV_KEY[slot];
    if (!envKey) continue;
    // Every slot — subagent included — carries the [1m] tag when its model has a
    // 1M window. Claude Code consumes the tag client-side to size the context
    // window and strips it before the provider call, so Fireworks still sees a
    // real model id. Leaving it off a 1M model makes Claude Code fall back to the
    // window it assumes for an unrecognized id (200K) and auto-compact enforces
    // that assumption, which thrashes subagents that the server could have served.
    merged[envKey] = shortFireworksModelRef(claudeCodeModelId(modelId));
  }
  return merged;
}

export function mergeModelsIntoEnv(env, mapping) {
  return withoutLegacyAnthropicMainEnv({
    ...env,
    ...modelEnvFromMapping(mapping),
  });
}

export function buildFireworksProviderEnv(env, {
  apiKey = "",
  baseUrl = FIREWORKS_BASE_URL,
  mapping,
  preset = DEFAULT_FIREWORKS_PRESET,
  anthropicKey = "",
  anthropicAuthToken = "",
  openaiKey = "",
  nexusProviders = "",
  useApiKeySentinel = true,
  telemetryHeaders = buildFireconnectTelemetryHeaders("claude"),
  pinSlotMapping = false,
  firerouterHeaders = false,
}) {
  const slotMapping = pinSlotMapping ? mapping : defaultClaudeModelMapping();
  const mergedEnv = pinSlotMapping ? mergeModelsIntoEnv({}, slotMapping) : {};
  const nextEnv = withoutLegacyAnthropicMainEnv({
    ...env,
    ...preset,
    ...(pinSlotMapping ? syncFireworksModelDisplay(mergedEnv, slotMapping) : {}),
    ANTHROPIC_BASE_URL: baseUrl,
  });
  if (!pinSlotMapping) {
    for (const key of MODEL_MAPPING_ENV_KEYS) {
      delete nextEnv[key];
    }
    for (const slot of ["opus", "sonnet", "haiku", "fable", "subagent"]) {
      const prefix = slot === "subagent"
        ? "CLAUDE_CODE_SUBAGENT_MODEL"
        : `ANTHROPIC_DEFAULT_${slot.toUpperCase()}_MODEL`;
      delete nextEnv[`${prefix}_NAME`];
      delete nextEnv[`${prefix}_DESCRIPTION`];
      delete nextEnv[`${prefix}_SUPPORTED_CAPABILITIES`];
    }
  }
  delete nextEnv.ANTHROPIC_API_KEY;
  delete nextEnv.ANTHROPIC_AUTH_TOKEN;
  // Let Claude Code emit its normal attribution block. The Fireworks gateway
  // strips that synthetic block before inference, while disabling it client-side
  // breaks Claude Code's classifier/auto-mode behavior.
  delete nextEnv.CLAUDE_CODE_ATTRIBUTION_HEADER;
  // Authenticate the gateway via X-Fireworks-Api-Key. Native Claude auth stays
  // in Claude's own env fields; it must never be copied to x-anthropic-api-key.
  if (apiKey?.trim()) {
    const preservedHeaders = env.ANTHROPIC_CUSTOM_HEADERS ?? "";
    nextEnv.ANTHROPIC_CUSTOM_HEADERS = firerouterHeaders
      ? [
        buildClaudeCustomHeaders({
          fireworksKey: apiKey.trim(),
          openaiKey,
          nexusProviders,
          telemetryHeaders,
        }),
        preservedHeaders,
      ].filter(Boolean).join("\n")
      : setFireworksKeyInCustomHeaders(
        mergeFireconnectTelemetryHeaderLines(preservedHeaders, telemetryHeaders),
        apiKey.trim(),
      );
    // The auto router's provider scope rides the same custom-headers line
    // on non-firerouter mappings too (and survives /model switching to
    // auto). stripFirerouterOwnedEnv already removed any stale line above.
    if (!firerouterHeaders && nexusProviders?.trim()
      && !customHeaderValue(nextEnv.ANTHROPIC_CUSTOM_HEADERS, [NEXUS_PROVIDERS_HEADER])) {
      nextEnv.ANTHROPIC_CUSTOM_HEADERS = [
        nextEnv.ANTHROPIC_CUSTOM_HEADERS,
        `${NEXUS_PROVIDERS_HEADER}: ${nexusProviders.trim()}`,
      ].filter(Boolean).join("\n");
    }
  }
  // An OpenAI key saved with `nexus auto` rides along so Nexus Auto (`auto`)
  // can use OpenAI models (bare `firerouter` already carries it via
  // buildClaudeCustomHeaders above). Never duplicated, never prompted for.
  if (openaiKey?.trim() && !openaiKeyFromCustomHeaders(nextEnv.ANTHROPIC_CUSTOM_HEADERS)) {
    nextEnv.ANTHROPIC_CUSTOM_HEADERS = [
      nextEnv.ANTHROPIC_CUSTOM_HEADERS,
      `${OPENAI_BYOK_HEADER}: ${openaiKey.trim()}`,
    ].filter(Boolean).join("\n");
  }
  if (anthropicKey?.trim()) {
    nextEnv.ANTHROPIC_API_KEY = anthropicKey.trim();
  } else if (useApiKeySentinel) {
    // Claude Code's fresh-profile login gate requires an API-key-shaped env
    // field before it will send custom headers. This non-secret sentinel unlocks
    // that gate; X-Fireworks-Api-Key remains the real gateway credential.
    nextEnv.ANTHROPIC_API_KEY = "fireconnect";
  }
  if (anthropicAuthToken?.trim()) {
    nextEnv.ANTHROPIC_AUTH_TOKEN = anthropicAuthToken.trim();
  }
  // Native Claude slots leave no pin behind: clear the slot's model + picker
  // label keys (including any pre-existing user values that survived the env
  // spread) so Claude Code falls back to its own (Anthropic) default model.
  for (const [slot, modelId] of Object.entries(slotMapping)) {
    if (!isClaudeNativeModel(modelId)) {
      continue;
    }
    for (const key of envKeysToClearForNativeSlot(slot)) {
      delete nextEnv[key];
    }
  }
  return applyClaudeCodeContextPolicy(nextEnv, slotMapping);
}

/**
 * The top-level `model` (Claude Code's /model default) that `on` writes. Pure
 * so `on` can decide header eligibility (e.g. the OpenAI key on a firerouter
 * default) against the model that actually lands, before writing anything.
 * @param {{
 *   currentModel?: unknown,
 *   selectedPickerModel?: string,
 *   mapping: Record<string, string>,
 *   registerablePickerIds?: string[],
 * }} args
 * @returns {string}
 */
export function resolveClaudeDefaultModel({
  currentModel,
  selectedPickerModel = "",
  mapping,
  registerablePickerIds = [],
}) {
  if (selectedPickerModel) {
    // `--model` selects the same row it ensures in /model, matching the
    // other picker harnesses. Tier env slots remain native/unpinned.
    return shortFireworksModelRef(claudeCodeModelId(selectedPickerModel));
  }
  if (isClaudeNativeModel(mapping.main)) {
    // Native main (the default, or an explicit `native` sentinel): the
    // top-level `model` field is Claude Code's saved /model default.
    // A selection the current picker serves (catalog row, auto*) stays;
    // anything else — no selection, a native tier id like `opus`, a stale
    // pin, or a FireRouter selection carried over from an earlier `on` —
    // would send an unservable model id to the gateway, so the `auto` mix
    // is pinned as the default instead. A `--model firerouter...` request is
    // rejected at admission and never reaches this branch.
    const servablePickerModels = new Set(
      buildFireconnectModelPickerOptions(registerablePickerIds)
        .map((option) => option.model),
    );
    const savedDefault = typeof currentModel === "string"
      ? shortFireworksModelRef(currentModel)
      : "";
    return savedDefault && !isRetiredModelId(savedDefault) && servablePickerModels.has(savedDefault)
      ? currentModel
      : shortFireworksModelRef(claudeCodeModelId(AUTO_MODEL_ID));
  }
  // A pinned main is the Claude Code default row itself.
  return shortFireworksModelRef(claudeCodeModelId(mapping.main));
}

/**
 * Pure builder: the settings object `enableFireworksProvider` would write to
 * disk, WITHOUT reading or writing any file.
 *
 * @param {Record<string, unknown>} settings  current settings (env read from here)
 * @param {{
 *   apiKey?: string,
 *   baseUrl?: string,
 *   mapping?: ReturnType<typeof resolveClaudeModelMapping>,
 *   preset?: Record<string, string>,
 *   anthropicKey?: string,
 *   anthropicAuthToken?: string,
 *   openaiKey?: string,
 *   nexusProviders?: string,
 *   useApiKeySentinel?: boolean,
 *   registerablePickerIds?: string[],
 *   selectedPickerModel?: string,
 *   firerouterHeaders?: boolean,
 * }} [opts]
 * @returns {{ settings: Record<string, unknown>, token: string }}
 */
export function buildFireworksSettings(settings, {
  apiKey = "",
  baseUrl = FIREWORKS_BASE_URL,
  mapping = resolveClaudeModelMapping(),
  preset = DEFAULT_FIREWORKS_PRESET,
  anthropicKey = "",
  anthropicAuthToken = "",
  openaiKey = "",
  nexusProviders = "",
  useApiKeySentinel = true,
  registerablePickerIds = [],
  selectedPickerModel = "",
  firerouterHeaders = false,
} = {}) {
  const env = settings.env ?? {};
  const token = apiKey || claudeFireworksKeyFrom({ env }) || process.env.FIREWORKS_API_KEY || "";
  if (!token) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  // stripFirerouterOwnedEnv keeps any user-added ANTHROPIC_CUSTOM_HEADERS lines
  // (only Nexus-managed lines are removed), so buildFireworksProviderEnv
  // can re-add just the Fireworks key alongside them.
  const { env: strippedEnv } = stripFirerouterOwnedEnv(env);
  // Slots are pinned only when the mapping carries explicit tier overrides
  // (`--opus` … `--subagent`). All-native mappings keep the previous strip
  // behavior so tier slots stay on Claude defaults and only the /model picker
  // is appended.
  const pinSlotMapping = Object.values(mapping).some((modelId) => !isClaudeNativeModel(modelId));
  let next = {
    ...settings,
    env: buildFireworksProviderEnv(strippedEnv, {
      apiKey: token,
      baseUrl,
      mapping,
      preset,
      anthropicKey,
      anthropicAuthToken,
      openaiKey,
      nexusProviders,
      useApiKeySentinel,
      pinSlotMapping,
      firerouterHeaders,
    }),
  };
  if (providerStatusFromEnv(next.env) === "fireworks") {
    // Refresh is a re-`on` behavior: the install was already Fireworks-routed
    // (or the picker still carries the Nexus marker), so its non-Claude rows
    // are Nexus territory and are rebuilt from the current catalog. A first
    // connect instead appends to whatever picker the user already has.
    const refreshPicker = providerStatusFromEnv(env) === "fireworks"
      || isFireconnectModelPicker(settings.modelPicker);
    next = withFireconnectModelPicker(next, registerablePickerIds, {
      refresh: refreshPicker,
      // This run's --model and the saved default both survive a refresh
      // (as the upgrade migration already protects the saved default);
      // retired defaults (FireRouter, auto-instant) are not protected —
      // they move to `auto` below instead.
      protectedIds: [selectedPickerModel, settings.model]
        .filter((id) => typeof id === "string" && id && !isRetiredModelId(id)),
    });
    // FireRouter rows do not survive the picker refresh (above), so they
    // must not count as servable when deciding whether the saved default
    // stays — `resolveClaudeDefaultModel` drops a FireRouter default to
    // `auto` for the same reason.
    next.model = resolveClaudeDefaultModel({
      currentModel: next.model,
      selectedPickerModel,
      mapping,
      registerablePickerIds,
    });
    // Claude Code prices the routed model against Anthropic's list, so its own
    // status line reports a cost the user is never billed. Ours reads the
    // transcript at Fireworks rates. A user's existing statusLine is left as-is.
    return { settings: withClaudeStatusLine(next), token };
  }
  return { settings: next, token };
}

export async function enableFireworksProvider({
  settingsPath,
  dataDir,
  effectiveApiKey,
  baseUrl = FIREWORKS_BASE_URL,
  mapping = resolveClaudeModelMapping(),
  preset = DEFAULT_FIREWORKS_PRESET,
  anthropicKey = "",
  anthropicAuthToken = "",
  openaiKey = "",
  nexusProviders = "",
  nativeApiKeyHelper = null,
  useApiKeySentinel = true,
  registerablePickerIds = [],
  selectedPickerModel = "",
  firerouterHeaders = false,
}) {
 const backupPath = providerBackupPath(dataDir);
 const settings = await readJsonIfExists(settingsPath);
 const statePath = providerStatePath(dataDir);
 const state = await readJsonIfExists(statePath);
 const env = settings.env ?? {};

  // Snapshot the raw settings file once, before any modification, so `off`
  // restores it byte-for-byte (like the other harnesses). Skip when a backup
  // already exists (preserve the true original across repeat `on`s) or when the
  // file is already Fireworks/FireRouter-routed (don't capture a
  // fireconnect-modified file as the "original").
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  const existingBackup = await readJsonIfExists(backupPath);
  const alreadyRouted = providerStatusFromEnv(env) === "fireworks";
  const backup = existingBackup.snapshot === undefined && existingBackup.values === undefined && !alreadyRouted
    ? await writeSettingsSnapshotBackup({ settingsPath, backupPath })
    : existingBackup;

  await ensureCatalogForClaudeCodeContext({ apiKey: effectiveApiKey });

  const built = buildFireworksSettings(settings, {
    apiKey: effectiveApiKey,
    baseUrl,
    mapping,
    preset,
    anthropicKey,
    anthropicAuthToken,
    openaiKey,
    nexusProviders,
    useApiKeySentinel,
    registerablePickerIds,
    selectedPickerModel,
    firerouterHeaders,
  });
  const token = built.token;
  const routed = nativeApiKeyHelper === null
    ? built.settings
    : { ...built.settings, apiKeyHelper: nativeApiKeyHelper };
  // Direct mode now authenticates via the X-Fireworks-Api-Key custom header
  // (written into env by buildFireworksProviderEnv), not apiKeyHelper. Drop a
  // previously Nexus-managed apiKeyHelper; a user's own helper is left
  // untouched (the raw snapshot restores it on `off`).
  const { settings: withoutHelper } = stripManagedApiKeyHelper(routed, {
    authMode: state.authMode,
    managedApiKeyHelper: state.managedApiKeyHelper,
  });
  const { settings: withoutAutoModePin } = stripRetiredAutoModeServerPin(withoutHelper, backup);
  const { settings: withoutAutoUpdatePin } = stripRetiredAutoUpdatePin(withoutAutoModePin, backup);
  const { settings: next } = retireTelemetryOptOutsOnce(withoutAutoUpdatePin, backup, state);

  await writeJson(settingsPath, next, { mode: 0o600 });
  await writeJson(statePath, {
    ...state,
    retiredTelemetryOptOuts: true,
    authMode: "customHeader",
    keyType: "fireworks",
    managedApiKeyHelper: undefined,
    fireworksApiKey: undefined,
  });
  return { token, settings: next };
}

export async function disableFireworksProvider({ settingsPath, dataDir, wasEnabled = false }) {
  const backupPath = providerBackupPath(dataDir);
  const statePath = providerStatePath(dataDir);
  const state = await readJsonIfExists(statePath);
  const settings = await readJsonIfExists(settingsPath);
  const backup = await readJsonIfExists(backupPath);
  const env = settings.env ?? {};
  const status = providerStatusFromEnv(env);
  const hasSnapshot = backup.snapshot !== undefined;
  const hasBackup = Boolean(backup.values);

  if (!wasEnabled && !hasBackup && !hasSnapshot && status !== "fireworks") {
    return;
  }

  // Preferred path: restore the raw settings snapshot byte-for-byte.
  if (hasSnapshot) {
    await restoreSettingsSnapshotBackup({ settingsPath, backupPath, backup });
    await writeJson(statePath, {
      ...state,
      authMode: undefined,
      keyType: undefined,
      managedApiKeyHelper: undefined,
      fireworksApiKey: undefined,
    });
    return;
  }

  if (hasBackup) {
    const nextEnv = { ...env };
    for (const key of FIREWORKS_ENV_KEYS) {
      delete nextEnv[key];
    }
    for (const [key, value] of Object.entries(backup.values)) {
      nextEnv[key] = value;
    }
    for (const key of backup.missing ?? []) {
      delete nextEnv[key];
    }
    // ANTHROPIC_CUSTOM_HEADERS isn't in FIREWORKS_ENV_KEYS; strip the Fireworks
    // key line so a legacy (values-only) restore never leaves it in plaintext.
    // Only the Fireworks/telemetry lines go: this env just came out of the
    // user's own backup, so their BYOK/scope lines in it are theirs to keep.
    if (typeof nextEnv.ANTHROPIC_CUSTOM_HEADERS === "string") {
      const stripped = stripFireconnectTelemetryHeaderLines(
        stripFireworksKeyFromCustomHeaders(nextEnv.ANTHROPIC_CUSTOM_HEADERS),
      );
      if (stripped) {
        nextEnv.ANTHROPIC_CUSTOM_HEADERS = stripped;
      } else {
        delete nextEnv.ANTHROPIC_CUSTOM_HEADERS;
      }
    }

    let nextSettings = { ...settings, env: nextEnv };
    if (backup.topLevel?.values || backup.topLevel?.missing) {
      nextSettings = applyTopLevelBackup(nextSettings, backup.topLevel);
    } else {
      nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
    }
    nextSettings = stripManagedApiKeyHelper(nextSettings, state).settings;
    // This legacy backup predates the managed status line and model picker, so
    // it cannot restore their absence — strip them explicitly (a user's own
    // statusLine / modelPicker is untouched).
    nextSettings = stripClaudeStatusLine(nextSettings).settings;
    nextSettings = stripFireconnectModelPicker(nextSettings).settings;

    await writeJson(settingsPath, nextSettings);
    await writeJson(statePath, {
      ...state,
      authMode: state.authMode === "apiKeyHelper" ? undefined : state.authMode,
      keyType: undefined,
      managedApiKeyHelper: undefined,
      fireworksApiKey: undefined,
    });
    await unlink(backupPath).catch(() => {});
    return;
  }

  const { env: nextEnv, changed: envChanged } = stripFireworksOwnedEnv(env);
  let nextSettings = { ...settings, env: nextEnv };
  const clearedTopLevel = status === "fireworks";
  if (clearedTopLevel) {
    nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
  }

  const { settings: clearedSettings, changed: helperChanged } = stripManagedApiKeyHelper(nextSettings, state);
  nextSettings = clearedSettings;

  const { settings: withoutStatusLine, changed: statusLineChanged } = stripClaudeStatusLine(nextSettings);
  nextSettings = withoutStatusLine;
  const { settings: withoutPicker, changed: pickerChanged } = stripFireconnectModelPicker(nextSettings);
  nextSettings = withoutPicker;

  if (envChanged || clearedTopLevel || helperChanged || statusLineChanged || pickerChanged) {
    await writeJson(settingsPath, nextSettings);
  }

  await writeJson(statePath, {
    ...state,
    authMode: undefined,
    keyType: undefined,
    managedApiKeyHelper: undefined,
    fireworksApiKey: undefined,
  });
}
