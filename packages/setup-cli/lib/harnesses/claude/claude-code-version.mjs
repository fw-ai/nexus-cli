import { spawnSync } from "node:child_process";
import process from "node:process";

import { findCommand } from "../../harness/detect.mjs";
import { compareVersions } from "../../system/release-notes.mjs";

/**
 * First Claude Code release that reads `modelPicker` from settings.json.
 * Older releases ignore it, so /model lists only Claude's own rows plus
 * the current model, and none of the Fireworks catalog `on` registers.
 */
export const CLAUDE_CODE_MODEL_PICKER_MIN_VERSION = "2.1.242";

const VERSION_PROBE_TIMEOUT_MS = 5000;

/**
 * The `x.y.z` that leads a line of `claude --version` output
 * ("2.1.227 (Claude Code)").
 * @param {unknown} output
 */
export function parseClaudeCodeVersion(output) {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)/m.exec(String(output ?? ""));
  return match ? match.slice(1, 4).join(".") : "";
}

/**
 * The Claude Code version on PATH, or "" when it can't be read. Never
 * throws and never waits more than a few seconds. Specs describe the
 * installed version in NEXUS_TEST_CLAUDE_VERSION instead of running it.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [options]
 */
export function installedClaudeCodeVersion({ env = process.env, platform = process.platform } = {}) {
  if (env.NEXUS_TEST === "1") {
    return parseClaudeCodeVersion(env.NEXUS_TEST_CLAUDE_VERSION);
  }
  try {
    const bin = findCommand("claude", { env, platform });
    // npm's Windows shims only run through a shell; skip them rather than spawn one.
    if (!bin || /\.(cmd|bat)$/i.test(bin)) {
      return "";
    }
    const result = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    return result.status === 0 ? parseClaudeCodeVersion(result.stdout) : "";
  } catch {
    return "";
  }
}

/** Whether this Claude Code version shows the Fireworks catalog in /model; unknown counts as yes. */
export function claudeCodeShowsModelPicker(version) {
  return !version || compareVersions(version, CLAUDE_CODE_MODEL_PICKER_MIN_VERSION) >= 0;
}

/**
 * A note for Claude Code releases too old to show the Fireworks catalog in
 * /model, or "" when the version is current or unknown.
 * @param {string} version
 */
export function claudeCodeModelPickerNote(version) {
  if (claudeCodeShowsModelPicker(version)) {
    return "";
  }
  return `Claude Code ${version} can't show the Fireworks catalog in /model; `
    + `that needs ${CLAUDE_CODE_MODEL_PICKER_MIN_VERSION} or newer. Run \`claude update\`.`;
}
