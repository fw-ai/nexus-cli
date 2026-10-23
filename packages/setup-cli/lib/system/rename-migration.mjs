import { readFile } from "node:fs/promises";


import { migrateDesktopShimAgentOnUpgrade } from "../harnesses/claude-desktop/upgrade-migrations.mjs";
import { userSettingsPath } from "../harnesses/claude/core.mjs";
import {
  migrateClaudeApiKeyHelperLauncherOnUpgrade,
  migrateClaudeAttributionHeaderLeftoverOnUpgrade,
  migrateClaudeStatusLinePathOnUpgrade,
} from "../harnesses/claude/upgrade-migrations.mjs";
import { codexConfigPath } from "../harnesses/codex/core.mjs";
import {
  copilotDataDbPath,
  findFireconnectProvider,
  isCopilotRunning,
  rewriteCopilotAppProviderSettings,
} from "../harnesses/copilot-app/sqlite.mjs";
import { copilotProvidersPath } from "../harnesses/copilot-cli/config.mjs";
import { opencodeConfigPath } from "../harnesses/opencode/core.mjs";
import { piModelsPath } from "../harnesses/pi/core.mjs";
import { chatLanguageModelsPath } from "../harnesses/vscode/core.mjs";
import { writeFileAtomic } from "../io/atomic-write.mjs";
import { removeLegacyShellHooks } from "../io/shell-env-hook.mjs";
import { retargetLegacyReferer } from "../telemetry/request-headers.mjs";
import {
  dataDirMigrationNote,
  dataDirNoteShown,
  markRenameMigrationComplete,
  migrateLegacyDataDir,
} from "./data-dir.mjs";
import { migrateLegacyLaunchers } from "./launchers.mjs";

/** @typedef {{ isCopilotAppRunning?: () => boolean }} RenameMigrationOptions */

/**
 * Rewrite the pre-rename `fireconnect/v<version>` referer baked into harness
 * configs so existing setups report as Nexus without a re-`on`.
 * @param {string} home
 * @param {{ isCopilotAppRunning?: () => boolean }} [options]
 * @returns {Promise<boolean>} true when any file changed
 */
async function retargetHarnessReferers(home, { isCopilotAppRunning = isCopilotRunning } = {}) {
  const files = [
    userSettingsPath(home),
    opencodeConfigPath(home, ""),
    codexConfigPath(home),
    piModelsPath(home),
    chatLanguageModelsPath({ home }),
    copilotProvidersPath({ home }),
  ];
  let changed = false;
  for (const file of files) {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const next = retargetLegacyReferer(raw);
    if (next !== raw) {
      await writeFileAtomic(file, next);
      changed = true;
    }
  }
  // A running app can overwrite data.db from its in-memory state; the
  // reconnect note below covers that case.
  try {
    if (!isCopilotAppRunning()
      && await rewriteCopilotAppProviderSettings(copilotDataDbPath({ home }), retargetLegacyReferer)) {
      changed = true;
    }
  } catch {
    // Left for the reconnect note below.
  }
  return changed;
}

/**
 * The Copilot app keeps its referer in SQLite, which the step above skips
 * while the app is open.
 * @param {string} home
 * @returns {Promise<boolean>} true while its provider still sends the pre-rename referer
 */
async function copilotAppNeedsReconnect(home) {
  const provider = await findFireconnectProvider(copilotDataDbPath({ home }));
  return Boolean(provider) && retargetLegacyReferer(provider.settings_json) !== provider.settings_json;
}

/**
 * Everything outside the data directory that still points at the pre-rename
 * layout. Each step is idempotent and best-effort.
 * @type {Array<{ run: (home: string, options: RenameMigrationOptions) => Promise<boolean>, success: string, failure: string }>}
 */
const REPOINT_STEPS = [
  {
    run: removeLegacyShellHooks,
    success: "Removed the old fireconnect shell hook from your shell profile. Open a new terminal to pick up the change.",
    failure: "Couldn't update the fireconnect shell hook in your shell profile. Remove the `# >>> fireconnect >>>` block by hand.",
  },
  {
    run: migrateClaudeApiKeyHelperLauncherOnUpgrade,
    success: "Pointed Claude Code's API key helper at the `nexus` command.",
    failure: "Couldn't update Claude Code's API key helper — re-run nexus claude on.",
  },
  {
    run: migrateClaudeAttributionHeaderLeftoverOnUpgrade,
    success: "",
    failure: "",
  },
  {
    run: migrateClaudeStatusLinePathOnUpgrade,
    success: "Pointed Claude Code's status line at ~/.nexus.",
    failure: "Couldn't update Claude Code's status line path — re-run nexus claude on.",
  },
  {
    run: retargetHarnessReferers,
    success: "Updated your harness configs to identify as Nexus CLI — restart them to pick it up.",
    failure: "Couldn't update every harness to identify as Nexus CLI — re-run `nexus <harness> on` for each one.",
  },
  {
    run: copilotAppNeedsReconnect,
    success: "Quit GitHub Copilot and run `nexus copilot-app on` once so it identifies as Nexus CLI too.",
    failure: "",
  },
  {
    run: (home) => migrateDesktopShimAgentOnUpgrade(home),
    success: "Restarted the Claude Desktop shim from ~/.nexus.",
    failure: "Couldn't move the Claude Desktop shim to ~/.nexus — re-run nexus claude-desktop on.",
  },
];

/**
 * FireConnect → Nexus: move `~/.fireconnect` to `~/.nexus`, then repoint the
 * launcher, shell hooks, Claude's status line, harness referers, and the
 * Desktop shim in the same breath. Runs before any network work in finalize, because open harness
 * sessions call those paths and break until they are repointed.
 *
 * @param {string} home
 * @param {RenameMigrationOptions & { migrateDataDir?: typeof migrateLegacyDataDir }} [options]
 * @returns {Promise<string[]>} notes for the user
 */
export async function runRenameMigration(home, { migrateDataDir = migrateLegacyDataDir, ...options } = {}) {
  if (!home) {
    return [];
  }
  const dataDirStatus = migrateDataDir(home);
  const dataDirNote = dataDirMigrationNote(dataDirStatus);
  const notes = dataDirNoteShown(dataDirNote) ? [] : [dataDirNote];
  if (dataDirStatus === "foreign") {
    // Nothing was moved, so there is nothing to repoint — and the rename is
    // not complete. Running the steps below would point launchers and
    // harness configs at a directory this CLI does not own, and marking
    // completion would write its marker into that directory, after which
    // it would be misrecognized as ours.
    return notes.filter(Boolean);
  }
  let complete = dataDirStatus !== "deferred" && dataDirStatus !== "failed";
  try {
    notes.push(...await migrateLegacyLaunchers(home));
  } catch {
    // The legacy launcher stays in place until a later run.
    complete = false;
  }
  for (const { run, success, failure } of REPOINT_STEPS) {
    try {
      notes.push(await run(home, options) ? success : "");
    } catch {
      notes.push(failure);
      complete = false;
    }
  }
  if (complete) {
    markRenameMigrationComplete(home);
  }
  return notes.filter(Boolean);
}
