import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { isFirerouterModelPattern } from "../../fireworks/model-specs.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { DATA_DIRNAME, retargetLegacyPath } from "../../system/data-dir.mjs";
import { claudeDesktopDataDir } from "./core.mjs";
import { thirdPartyDir } from "./lineup.mjs";
import {
  LEGACY_SHIM_AGENT_LABEL, SHIM_AGENT_LABEL, launchAgentPlistPath, startLaunchAgent, startShimService, stopLaunchAgent,
} from "./platform.mjs";
import { readProfileState, shimPlistPath, shimServicePath, shimStatePath } from "./profile-lane.mjs";

/**
 * @param {string} file
 * @returns {Promise<string | null>}
 */
async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Move the shim LaunchAgent to the Nexus label and point it at `~/.nexus`:
 * unload the pre-rename job, then load the rewritten one, so the running shim
 * is replaced rather than duplicated. `on` and `off` also retire a pre-rename
 * job, in case this step never ran.
 * @param {string} home
 * @param {{
 *   platform?: NodeJS.Platform,
 *   start?: typeof startLaunchAgent,
 *   stop?: typeof stopLaunchAgent,
 * }} [options]
 * @returns {Promise<boolean>} true when the agent was updated
 */
export async function migrateDesktopShimAgentOnUpgrade(home, {
  platform = process.platform,
  start = startLaunchAgent,
  stop = stopLaunchAgent,
} = {}) {
  if (platform !== "darwin") {
    return false;
  }
  const plistPath = shimPlistPath(home);
  const legacyPath = launchAgentPlistPath(home, LEGACY_SHIM_AGENT_LABEL);
  const legacy = await readIfPresent(legacyPath);
  const raw = legacy ?? await readIfPresent(plistPath);
  if (raw === null) {
    return false;
  }
  const repointed = existsSync(path.join(home, DATA_DIRNAME)) ? retargetLegacyPath(raw) : raw;
  const next = repointed.replaceAll(LEGACY_SHIM_AGENT_LABEL, SHIM_AGENT_LABEL);
  if (legacy === null && next === raw) {
    return false;
  }
  await writeFileAtomic(plistPath, next);
  if (legacy !== null) {
    await stop({ allowSystemChanges: true, label: LEGACY_SHIM_AGENT_LABEL });
  }
  await start(plistPath, { allowSystemChanges: true, label: SHIM_AGENT_LABEL });
  // Last, so a failed stop or start leaves the legacy plist for the next run to retry.
  await rm(legacyPath, { force: true });
  return true;
}

/**
 * Scrub FireRouter custom models an earlier release added to Claude
 * Desktop: the durable `manual-models.json` entries, the shim's live model
 * map, and the active profile's picker entries that pointed at them. The
 * lineup itself never contains FireRouter, so a profile Nexus didn't add
 * customs to is untouched. Runs whenever a Desktop profile state exists;
 * the next `claude-desktop on` would drop the same entries.
 * @param {string} home
 * @returns {Promise<boolean>} true when any file was updated
 */
export async function migrateClaudeDesktopFirerouterOnUpgrade(home) {
  if (!home || !(await readProfileState(home))) {
    return false;
  }
  const dataDir = claudeDesktopDataDir(home);
  const manualPath = path.join(dataDir, "manual-models.json");
  const manual = await readJsonIfExists(manualPath).catch(() => []);
  const manualList = Array.isArray(manual) ? manual : [];
  const dropped = manualList.filter((m) => isFirerouterModelPattern(m?.shortId ?? ""));
  const droppedNames = new Set(dropped.map((m) => m?.name).filter(Boolean));
  let changed = false;
  if (dropped.length) {
    await writeJson(manualPath, manualList.filter((m) => !dropped.includes(m)));
    changed = true;
  }

  const statePath = shimStatePath(home);
  const state = await readJsonIfExists(statePath).catch(() => ({}));
  const models = state?.modelMap?.models;
  if (models && typeof models === "object") {
    const kept = Object.fromEntries(
      Object.entries(models).filter(([name, shortId]) => {
        if (isFirerouterModelPattern(String(shortId ?? ""))) {
          droppedNames.add(name);
          return false;
        }
        return true;
      }),
    );
    if (Object.keys(kept).length !== Object.keys(models).length) {
      await writeJson(statePath, { ...state, modelMap: { ...state.modelMap, models: kept } });
      changed = true;
    }
  }

  if (droppedNames.size) {
    const profileState = await readProfileState(home);
    const profileId = profileState?.profileId;
    if (typeof profileId === "string" && profileId) {
      const profilePath = path.join(thirdPartyDir(home), "configLibrary", `${profileId}.json`);
      const profile = await readJsonIfExists(profilePath).catch(() => null);
      if (Array.isArray(profile?.inferenceModels)) {
        const kept = profile.inferenceModels.filter((m) => !droppedNames.has(m?.name));
        if (kept.length !== profile.inferenceModels.length) {
          await writeJson(profilePath, { ...profile, inferenceModels: kept }, { mode: 0o600 });
          changed = true;
        }
      }
    }
  }
  return changed;
}

/**
 * Restart the running Desktop shim after an update, so the new code —
 * including the live Nexus Auto scope and saved-key loaders — is what
 * actually serves requests. The shim loads its code at process start;
 * without a restart an upgraded install keeps the previous release's
 * shim in memory while the CLI reports live pickup.
 * @param {string} home
 * @param {{ platform?: NodeJS.Platform, start?: typeof startShimService }} [options]
 * @returns {Promise<boolean>} true when the service was restarted
 */
export async function restartClaudeDesktopShimOnUpgrade(home, {
  platform = process.platform,
  start = startShimService,
} = {}) {
  if (!home || process.env.NEXUS_TEST === "1") {
    return false;
  }
  if (!(await readProfileState(home))) {
    return false;
  }
  const servicePath = platform === "linux" ? shimServicePath(home) : shimPlistPath(home);
  if (!existsSync(servicePath)) {
    return false;
  }
  await start(servicePath, { allowSystemChanges: true, label: SHIM_AGENT_LABEL, platform });
  return true;
}
