import {
  migrateClaudeExploreInheritCapOnUpgrade,
  migrateClaudeFirerouterOnUpgrade,
  migrateClaudeModelPickerOnUpgrade,
  migrateClaudeNativeWebSearchOnUpgrade,
  migrateClaudeRetiredAutoModeServerPinOnUpgrade,
  migrateClaudeToolSearchOnUpgrade,
} from "../harnesses/claude/upgrade-migrations.mjs";
import {
  migrateCodexCatalogConstantsOnUpgrade,
  migrateCodexWebSearchOnUpgrade,
} from "../harnesses/codex/upgrade-migrations.mjs";
import {
  migrateOpencodeFirerouterOnUpgrade,
  migrateOpencodePickerDuplicatesOnUpgrade,
  migrateOpencodeV2ProvidersOnUpgrade,
} from "../harnesses/opencode/upgrade-migrations.mjs";
import { refreshPiCatalogForHome } from "../harnesses/pi/upgrade-migrations.mjs";
import { migrateCopilotCliFirerouterOnUpgrade } from "../harnesses/copilot-cli/upgrade-migrations.mjs";
import { migrateCopilotAppFirerouterOnUpgrade } from "../harnesses/copilot-app/upgrade-migrations.mjs";
import { migrateCursorFirerouterOnUpgrade } from "../harnesses/cursor/upgrade-migrations.mjs";
import { migrateDeepseekFirerouterOnUpgrade } from "../harnesses/deepseek/upgrade-migrations.mjs";
import { migrateClaudeDesktopFirerouterOnUpgrade } from "../harnesses/claude-desktop/upgrade-migrations.mjs";
import { migrateVscodeFirerouterOnUpgrade } from "../harnesses/vscode/upgrade-migrations.mjs";
import { migrateVscodeResponsesApiType } from "../harnesses/vscode/upgrade-migrations.mjs";
import { HARNESS } from "../harness/id.mjs";
import { ensureAutoCatalogEntry } from "../harness/auto-catalog.mjs";
import { RETIRED_ROUTING_PREFERENCE_HEADER } from "../firerouter/core.mjs";
import { removeSavedProviderKeysFromHarnesses } from "../keys/sync.mjs";

/**
 * Key-independent harness config migrations for install/upgrade finalize.
 *
 * Kept out of `keys/sync.mjs` so key rebake stays a key path. Each step is
 * best-effort: a failed migration never skips the rest or aborts finalize.
 *
 * @type {Array<{
 *   run: (home: string) => Promise<boolean>,
 *   success: string,
 *   failure: string,
 * }>}
 */
/**
 * Auto backfills share one implementation; the upgrade step reports them as
 * one combined note. Each row is [harnessId, label, failure hint].
 */
const AUTO_CATALOG_MIGRATIONS = [
  [HARNESS.OPENCODE, "OpenCode", "re-run nexus opencode on"],
  [HARNESS.CODEX, "Codex", "re-run nexus codex on"],
  [HARNESS.CURSOR, "Cursor", "quit Cursor, then re-run nexus update"],
  [HARNESS.VSCODE, "VS Code", "quit VS Code, then re-run nexus update"],
  [HARNESS.COPILOT_APP, "the Copilot app", "quit it, then re-run nexus update"],
  [HARNESS.COPILOT_CLI, "the Copilot CLI", "re-run nexus copilot-cli on"],
];

/** "A", "A and B", "A, B and C". */
function joinLabels(labels) {
  if (labels.length <= 2) {
    return labels.join(" and ");
  }
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * One upgrade step for every auto backfill: a single success note naming each
 * migrated harness, plus one failure note per harness that errored (recovery
 * differs, so failures stay separate). Best-effort throughout — a failure
 * never skips the remaining harnesses.
 * @param {string} home
 * @returns {Promise<string[]>}
 */
async function migrateAutoCatalogNotes(home) {
  const added = [];
  const notes = [];
  for (const [harnessId, label, hint] of AUTO_CATALOG_MIGRATIONS) {
    try {
      if (await ensureAutoCatalogEntry(harnessId, home)) {
        added.push(label);
      }
    } catch {
      notes.push(`Couldn't add the auto model to ${label} — ${hint}.`);
    }
  }
  if (added.length > 0) {
    notes.unshift(
      `Added the auto model to ${joinLabels(added)} — restart ${added.length > 1 ? "them" : "it"} to pick it up.`,
    );
  }
  return notes;
}

const HARNESS_FORWARD_MIGRATIONS = [
  {
    run: migrateVscodeResponsesApiType,
    success: "Updated VS Code's Fireworks provider to the chat-completions API — restart VS Code to pick it up.",
    failure: "Couldn't migrate VS Code's Fireworks provider — restart VS Code, then re-run nexus update.",
  },
  {
    run: migrateClaudeToolSearchOnUpgrade,
    success: "Enabled MCP tool search for Claude Code (ENABLE_TOOL_SEARCH) — restart Claude Code to pick it up.",
    failure: "Couldn't enable MCP tool search for Claude Code — re-run nexus claude on.",
  },
  {
    run: migrateClaudeRetiredAutoModeServerPinOnUpgrade,
    success: "Removed the Claude Code auto mode classifier pin (CLAUDE_CODE_AUTO_MODE_SERVER=0). Restart Claude Code to apply it.",
    failure: "Couldn't remove the Claude Code auto mode classifier pin. Re-run nexus claude on.",
  },
  {
    run: migrateClaudeExploreInheritCapOnUpgrade,
    success: "Let the Explore agent inherit the session model (CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1) so exploration stays on Fireworks rates — restart Claude Code to pick it up.",
    failure: "Couldn't set Explore model inheritance for Claude Code — re-run nexus claude on.",
  },
  {
    run: migrateClaudeNativeWebSearchOnUpgrade,
    success: "Enabled native Claude web search and removed the retired Fireworks WebSearch MCP — restart Claude Code.",
    failure: "Couldn't migrate Claude to native web search — re-run nexus claude on.",
  },
  {
    run: migrateCodexWebSearchOnUpgrade,
    success: "Enabled Codex web search — restart Codex to pick it up.",
    failure: "Couldn't enable Codex web search — re-run nexus codex on.",
  },
  {
    run: migrateCodexCatalogConstantsOnUpgrade,
    success: "Updated Codex's Fireworks model catalog for MCP tool search — restart Codex to pick it up.",
    failure: "Couldn't update Codex's Fireworks model catalog for MCP tool search — re-run nexus codex on.",
  },
  {
    run: migrateOpencodeV2ProvidersOnUpgrade,
    success: "Added Nexus's provider to OpenCode v2's providers map so its models show up. Restart OpenCode to pick it up.",
    failure: "Couldn't update OpenCode's v2 providers map. Re-run nexus opencode on.",
  },
  {
    run: migrateOpencodePickerDuplicatesOnUpgrade,
    success: "Removed duplicate Fireworks models from OpenCode's /models picker. Restart OpenCode to pick it up.",
    failure: "Couldn't remove duplicate Fireworks models from OpenCode's picker. Re-run nexus opencode on.",
  },
  {
    run: migrateOpencodeFirerouterOnUpgrade,
    success: "Moved OpenCode off FireRouter to the auto model. Restart OpenCode to pick it up.",
    failure: "Couldn't move OpenCode off FireRouter. Re-run nexus opencode on.",
  },
  {
    run: refreshPiCatalogForHome,
    success: "Updated Pi's Fireworks models: Nexus now adds only the models Pi doesn't already know, so Pi's own settings apply to the rest. Restart Pi to pick it up.",
    failure: "Couldn't update Pi's Nexus setup. Re-run nexus pi on.",
  },
  {
    run: migrateClaudeModelPickerOnUpgrade,
    success: "Refreshed Claude Code's /model picker from the live catalog — restart Claude Code to pick it up.",
    failure: "Couldn't refresh Claude Code's /model picker — re-run nexus claude on.",
  },
  {
    run: migrateClaudeFirerouterOnUpgrade,
    success: "Moved Claude Code off FireRouter to the auto model — restart Claude Code to pick it up.",
    failure: "Couldn't move Claude Code off FireRouter — re-run nexus claude on.",
  },
  {
    run: migrateCopilotCliFirerouterOnUpgrade,
    success: "Moved the Copilot CLI off FireRouter to the auto model. Start a new copilot session to pick it up.",
    failure: "Couldn't move the Copilot CLI off FireRouter. Re-run nexus copilot-cli on.",
  },
  {
    run: migrateVscodeFirerouterOnUpgrade,
    success: "Removed FireRouter models from VS Code's model list — restart VS Code to pick it up.",
    failure: "Couldn't remove FireRouter models from VS Code — quit VS Code, then re-run nexus update.",
  },
  {
    run: migrateCopilotAppFirerouterOnUpgrade,
    success: "Removed FireRouter models from the Copilot app's model list — restart the Copilot app to pick it up.",
    failure: "Couldn't remove FireRouter models from the Copilot app — quit it, then re-run nexus update.",
  },
  {
    run: migrateCursorFirerouterOnUpgrade,
    success: "Moved Cursor off FireRouter to the auto model — quit and reopen Cursor to pick it up.",
    failure: "Couldn't move Cursor off FireRouter — quit Cursor, then re-run nexus update.",
  },
  {
    run: migrateDeepseekFirerouterOnUpgrade,
    success: "Moved DeepSeek Harness off FireRouter to the auto model. Restart dsh to pick it up.",
    failure: "Couldn't move DeepSeek Harness off FireRouter. Re-run nexus deepseek on.",
  },
  {
    run: migrateClaudeDesktopFirerouterOnUpgrade,
    success: "Removed FireRouter models from Claude Desktop's picker. Restart Claude Desktop to pick it up.",
    failure: "Couldn't remove FireRouter models from Claude Desktop. Re-run nexus claude-desktop on.",
  },
];

/**
 * Strip the header the deprecated `--routing-preference` wrote, so an upgrade
 * stops it reaching FireRouter without waiting for the next `on`.
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function migrateRetiredRoutingPreferenceNotes(home, options = {}) {
  const { updated, failed, skipped } = await removeSavedProviderKeysFromHarnesses(
    home,
    [RETIRED_ROUTING_PREFERENCE_HEADER],
    { skipRunningIdes: true, ...options },
  );
  const notes = [
    ...failed.map(({ id, label }) => (
      `Couldn't remove the deprecated routing preference from ${label} — re-run nexus ${id} on.`
    )),
    ...skipped.map(({ label }) => (
      `Couldn't remove the deprecated routing preference from ${label} while it's open — quit ${label}, then re-run nexus update.`
    )),
  ];
  if (updated.length > 0) {
    notes.unshift(
      `Removed the deprecated routing preference from ${joinLabels(updated)}: FireRouter routes are no longer supported. `
        + `Restart ${updated.length > 1 ? "them" : "it"} to pick it up.`,
    );
  }
  return notes;
}

async function migrationNote({ run, success, failure }, home) {
  try {
    return await run(home) ? success : "";
  } catch {
    return failure;
  }
}

/**
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function runHarnessForwardMigrations(home) {
  if (!home) {
    return [];
  }
  const notes = [];
  for (const migrate of HARNESS_FORWARD_MIGRATIONS) {
    const note = await migrationNote(migrate, home);
    if (note) {
      notes.push(note);
    }
  }
  notes.push(...await migrateRetiredRoutingPreferenceNotes(home));
  notes.push(...await migrateAutoCatalogNotes(home));
  return notes;
}
