import process from "node:process";

import { readGlobalConfig } from "../config/global-config.mjs";
import { createBaseContext } from "../cli/parse-args.mjs";
import {
  claudeFireconnectIntent,
  providerBackupPath,
  providerStatePath,
  resolveDataDir,
  userSettingsPath,
} from "../harnesses/claude/core.mjs";
import { readJsonIfExists } from "../io/json.mjs";
import { promptYesNo } from "../auth/login/prompts.mjs";
import { compareVersions } from "./release-notes.mjs";

export const CLAUDE_UPGRADE_PROMPT = "Claude Code is currently connected through FireConnect.\n\n"
  + "FireConnect must temporarily restore your original Claude settings before upgrading.\n\n"
  + "Continue?";

const NONINTERACTIVE_CLAUDE_UPGRADE_MESSAGE = "Claude Code is currently connected through FireConnect. "
  + "Run `fireconnect claude off`, then retry `fireconnect upgrade`, or set "
  + "`NEXUS_AUTO_OFF_CLAUDE=1` to restore automatically.";

/**
 * Pre-v0.9 installs needed a Claude restore before git reset. From 0.9.0 on,
 * harness settings are preserved across upgrade/reinstall — skip the prompt.
 */
export const CLAUDE_OFF_UPGRADE_BEFORE_VERSION = "0.9.0";

/**
 * @param {string} [installedVersion] Nexus version currently on disk
 * @returns {boolean}
 */
export function needsClaudeOffBeforeUpgrade(installedVersion = "") {
  const version = String(installedVersion ?? "").trim().replace(/^v/i, "");
  if (!version) {
    // Unknown / ancient installs: keep the restore path (fail closed).
    return true;
  }
  return compareVersions(version, CLAUDE_OFF_UPGRADE_BEFORE_VERSION) < 0;
}

/**
 * Combine the remembered enabled flag with evidence in Claude's managed files.
 * This is pure so detection rules can be tested without touching a real HOME.
 *
 * @param {{
 *   globalEnabled?: boolean,
 *   settings?: Record<string, unknown>,
 *   backup?: Record<string, unknown>,
 *   state?: Record<string, unknown>,
 * }} evidence
 */
export function claudeUpgradeState({
  globalEnabled = false,
  settings = {},
  backup = {},
  state = {},
} = {}) {
  const intent = claudeFireconnectIntent(settings, { backup, state });
  const managedSettings = Boolean(intent);
  return {
    enabled: Boolean(globalEnabled || managedSettings),
    globalEnabled: Boolean(globalEnabled),
    managedSettings,
  };
}

/**
 * Read all evidence used by the upgrade preflight. The readers are injectable
 * so focused tests do not need a real config tree.
 *
 * @param {string} home
 * @param {{
 *   readConfig?: typeof readGlobalConfig,
 *   readJson?: typeof readJsonIfExists,
 * }} [dependencies]
 */
export async function inspectClaudeUpgradeState(home, {
  readConfig = readGlobalConfig,
  readJson = readJsonIfExists,
} = {}) {
  const dataDir = resolveDataDir({ home });
  const [config, settings, backup, state] = await Promise.all([
    readConfig(home),
    readJson(userSettingsPath(home)),
    readJson(providerBackupPath(dataDir)),
    readJson(providerStatePath(dataDir)),
  ]);
  return claudeUpgradeState({
    globalEnabled: config.harnesses?.claude?.enabled === true,
    settings,
    backup,
    state,
  });
}

/**
 * Restore Claude before an update. Returns whether reset/install may proceed
 * and whether Claude was restored for the upgrade.
 *
 * Only needed when upgrading from FireConnect &lt; 0.9.0. From 0.9.0 on, harness
 * settings are left alone — this is a no-op that always proceeds.
 *
 * @param {{
 *   home: string,
 *   adapter: { off: (ctx: object) => Promise<void> },
 *   input?: NodeJS.ReadStream | { isTTY?: boolean },
 *   environment?: Record<string, string | undefined>,
 *   inspect?: typeof inspectClaudeUpgradeState,
 *   prompt?: typeof promptYesNo,
 *   installedVersion?: string,
 * }} options
 */
export async function runClaudeUpgradePreflight({
  home,
  adapter,
  input = process.stdin,
  environment = process.env,
  inspect = inspectClaudeUpgradeState,
  prompt = promptYesNo,
  installedVersion = "",
}) {
  if (!needsClaudeOffBeforeUpgrade(installedVersion)) {
    return { proceed: true, restored: false };
  }

  const before = await inspect(home);
  if (!before.enabled) {
    return { proceed: true, restored: false };
  }

  const autoOff = environment.NEXUS_AUTO_OFF_CLAUDE === "1";
  if (!autoOff) {
    if (!input.isTTY) {
      throw new Error(NONINTERACTIVE_CLAUDE_UPGRADE_MESSAGE);
    }

    const accepted = await prompt(CLAUDE_UPGRADE_PROMPT, {
      stdin: input,
      defaultYes: true,
    });
    if (!accepted) {
      return { proceed: false, restored: false };
    }
  }

  await adapter.off({
    ...createBaseContext(),
    home,
  });

  const after = await inspect(home);
  if (after.globalEnabled || after.managedSettings) {
    throw new Error(
      "Claude Code settings were not fully restored; upgrade cancelled. "
      + "Run `fireconnect claude off`, then retry `fireconnect upgrade`.",
    );
  }

  return { proceed: true, restored: true };
}
