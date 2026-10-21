/**
 * Persist last demo wizard choices under ~/.nexus/demo.json.
 */

import path from "node:path";

import { globalConfigPath } from "../config/global-config.mjs";
import { readJsonIfExists, writeJson } from "../io/json.mjs";

const DEMO_PREFS_BASENAME = "demo.json";

export function demoPreferencesPath(home) {
  return path.join(path.dirname(globalConfigPath(home)), DEMO_PREFS_BASENAME);
}

/**
 * @param {string} home
 * @returns {Promise<{ leftModel?: string, rightModel?: string, promptPresetId?: string, matchupPresetId?: string }>}
 */
export async function loadDemoPreferences(home) {
  const raw = await readJsonIfExists(demoPreferencesPath(home));
  return raw && typeof raw === "object" ? raw : {};
}

/**
 * @param {string} home
 * @param {{ leftModel: string, rightModel: string, promptPresetId: string, matchupPresetId?: string }} prefs
 */
export async function saveDemoPreferences(home, prefs) {
  if (!home?.trim()) {
    return;
  }
  await writeJson(demoPreferencesPath(home), {
    leftModel: prefs.leftModel,
    rightModel: prefs.rightModel,
    promptPresetId: prefs.promptPresetId,
    matchupPresetId: prefs.matchupPresetId ?? "",
  }, { mode: 0o600 });
}
