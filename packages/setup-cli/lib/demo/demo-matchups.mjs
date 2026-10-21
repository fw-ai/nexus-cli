/**
 * Curated matchup presets for the demo onboarding wizard.
 */

export const CUSTOM_MATCHUP_ID = "custom";

/** @typedef {{ id: string, label: string, description: string, leftModel: string, rightModel: string }} DemoMatchupPreset */

/** @type {DemoMatchupPreset[]} */
export const DEMO_MATCHUP_PRESETS = Object.freeze([
  {
    id: "subscription-vs-fireworks",
    label: "Claude Opus vs Fireworks",
    description: "Opus slot vs GLM Fast Latest",
    leftModel: "opus",
    rightModel: "glm-fast-latest",
  },
  {
    id: "router-vs-direct",
    label: "Auto router vs direct",
    description: "Auto vs GLM Fast Latest",
    leftModel: "auto",
    rightModel: "glm-fast-latest",
  },
  {
    id: "speed-duel",
    label: "Speed duel",
    description: "Kimi Fast Latest vs GLM Fast Latest",
    leftModel: "kimi-fast-latest",
    rightModel: "glm-fast-latest",
  },
]);

/** @returns {string[]} */
export function demoMatchupOptionIds() {
  return [...DEMO_MATCHUP_PRESETS.map((p) => p.id), CUSTOM_MATCHUP_ID];
}

/**
 * @param {string} id
 * @returns {DemoMatchupPreset | null}
 */
export function demoMatchupPreset(id) {
  return DEMO_MATCHUP_PRESETS.find((p) => p.id === id) ?? null;
}
