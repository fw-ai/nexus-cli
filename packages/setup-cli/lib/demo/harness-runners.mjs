/**
 * Headless raceable harness adapters for `nexus claude demo`.
 *
 * Each adapter owns:
 *   - `buildRaceSettings({ leftModel, rightModel, home, settingsPath })` — resolve
 *     per-side `--model` values against the user's fireconnected Claude profile.
 *   - `runSide({ cwd, prompt, model, signal, onDelta, ... })` — spawn `claude -p`
 *     headless for one side.
 */

import { HARNESS } from "../harness/id.mjs";
import { prepareRouteSettings } from "./route-settings.mjs";
import { runClaude } from "./claude-runner.mjs";

/** @type {Record<string, { id: string, label: string, buildRaceSettings: Function, runSide: Function }>} */
export const HEADLESS_RUNNERS = {
  [HARNESS.CLAUDE]: {
    id: HARNESS.CLAUDE,
    label: "Claude Code",
    buildRaceSettings: prepareRouteSettings,
    runSide: runClaude,
  },
};

export const SUPPORTED_HARNESS_IDS = Object.keys(HEADLESS_RUNNERS);

/**
 * @param {string} harnessId
 * @returns {{ id: string, label: string, buildRaceSettings: Function, runSide: Function } | null}
 */
export function getHeadlessRunner(harnessId) {
  return HEADLESS_RUNNERS[harnessId] ?? null;
}
