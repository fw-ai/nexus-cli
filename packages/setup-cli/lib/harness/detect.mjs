import { existsSync } from "node:fs";
import path from "node:path";
import { HARNESS } from "./id.mjs";
import { cursorStateDbPath } from "../harnesses/cursor/core.mjs";
import { chatLanguageModelsPath } from "../harnesses/vscode/core.mjs";
import { copilotDataDbPath } from "../harnesses/copilot-app/sqlite.mjs";
import { firstPartyDir, thirdPartyDir } from "../harnesses/claude-desktop/lineup.mjs";

/**
 * Best-effort detection of which harnesses look installed for `home`, by
 * probing each tool's config footprint on disk. Used only for cosmetic hints
 * (pre-selecting defaults in `nexus configure`, the launcher's status
 * column) — never to gate functionality, so a false negative just means the
 * user checks a box themselves.
 *
 * @param {string} home
 * @returns {import("./id.mjs").HarnessId[]}
 */
export function detectInstalledHarnesses(home) {
  if (!home) {
    return [];
  }

  const probes = {
    [HARNESS.CLAUDE]: [path.join(home, ".claude"), path.join(home, ".claude.json")],
    [HARNESS.CLAUDE_DESKTOP]: [firstPartyDir(home), thirdPartyDir(home)],
    [HARNESS.OPENCODE]: [
      path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"),
    ],
    [HARNESS.CODEX]: [path.join(home, ".codex")],
    [HARNESS.PI]: [path.join(home, ".pi")],
    [HARNESS.CURSOR]: [cursorStateDbPath({ home })],
    // The User dir exists on any VS Code install; chatLanguageModels.json
    // itself only appears once the user touches custom models.
    [HARNESS.VSCODE]: [path.dirname(chatLanguageModelsPath({ home }))],
    // Both products keep their config in ~/.copilot, so the same probe finds
    // either one; which is installed is the user's to say.
    [HARNESS.COPILOT_APP]: [path.dirname(copilotDataDbPath({ home }))],
    [HARNESS.COPILOT_CLI]: [path.dirname(copilotDataDbPath({ home }))],
    [HARNESS.DEEPSEEK]: [path.join(home, ".dsh")],
  };

  return Object.entries(probes)
    .filter(([, paths]) => paths.some((candidate) => existsSync(candidate)))
    .map(([id]) => id);
}
