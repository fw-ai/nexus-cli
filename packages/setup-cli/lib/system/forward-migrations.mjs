import {
  migrateClaudeBakedAnthropicKeyOnUpgrade,
  migrateClaudeExploreInheritCapOnUpgrade,
  migrateClaudeFirerouterOnUpgrade,
  migrateClaudeModelPickerOnUpgrade,
  migrateClaudeNativeWebSearchOnUpgrade,
  migrateClaudeRetiredAutoModeServerPinOnUpgrade,
  migrateClaudeRetiredAutoUpdatePinOnUpgrade,
  migrateClaudeTelemetryOptOutsOnUpgrade,
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
import {
  migrateClaudeDesktopFirerouterOnUpgrade,
  restartClaudeDesktopShimOnUpgrade,
} from "../harnesses/claude-desktop/upgrade-migrations.mjs";
import { migrateVscodeFirerouterOnUpgrade } from "../harnesses/vscode/upgrade-migrations.mjs";
import { migrateVscodeResponsesApiType } from "../harnesses/vscode/upgrade-migrations.mjs";
import { HARNESS } from "../harness/id.mjs";
import { isMigrationSkipped } from "./migration-skip.mjs";
import { ensureAutoCatalogEntry } from "../harness/auto-catalog.mjs";
import { RETIRED_ROUTING_PREFERENCE_HEADER } from "../firerouter/core.mjs";
import { removeSavedProviderKeysFromHarnesses } from "../keys/sync.mjs";
import {
  migrateEnvProviderKeyRefsOnUpgrade,
  migrateLegacyRouterAnthropicProviderOnUpgrade,
} from "./env-key-migrations.mjs";

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
 *   skipped?: string,
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
    skipped: "Didn't update VS Code's Fireworks provider while VS Code is open — the update continues; quit VS Code, then run `nexus vscode` to apply it.",
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
    run: migrateClaudeRetiredAutoUpdatePinOnUpgrade,
    success: "Removed the Claude Code auto-update pin (CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=0). Claude Code's own update settings apply again.",
    failure: "Couldn't remove the Claude Code auto-update pin. Re-run nexus claude on.",
  },
  {
    run: migrateClaudeTelemetryOptOutsOnUpgrade,
    success: "Removed the Claude Code telemetry opt-outs (DISABLE_TELEMETRY, DO_NOT_TRACK, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC), which older Nexus CLI versions set and which hid the Artifact tool. Nexus CLI no longer turns off Claude Code's telemetry. If you set any of these yourself, add them back in ~/.claude/settings.json — Nexus CLI won't remove them again. Restart Claude Code to apply it.",
    failure: "Couldn't remove the Claude Code telemetry opt-outs. Re-run nexus update.",
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
    success: "Added Nexus CLI's provider to OpenCode v2's providers map so its models show up. Restart OpenCode to pick it up.",
    failure: "Couldn't update OpenCode's v2 providers map. Re-run nexus opencode on.",
  },
  {
    run: migrateOpencodePickerDuplicatesOnUpgrade,
    success: "Removed duplicate Fireworks models from OpenCode's /models picker. Restart OpenCode to pick it up.",
    failure: "Couldn't remove duplicate Fireworks models from OpenCode's picker. Re-run nexus opencode on.",
  },
  {
    run: migrateOpencodeFirerouterOnUpgrade,
    success: "FireRouter is now Nexus Auto: moved OpenCode to `auto`. Restart OpenCode to pick it up.",
    failure: "Couldn't move OpenCode from FireRouter to Nexus Auto. Re-run nexus opencode on.",
  },
  {
    run: refreshPiCatalogForHome,
    success: "Updated Pi's Fireworks models: Nexus CLI now adds only the models Pi doesn't already know, so Pi's own settings apply to the rest. Restart Pi to pick it up.",
    failure: "Couldn't update Pi's Nexus CLI setup. Re-run nexus pi on.",
  },
  {
    run: migrateClaudeModelPickerOnUpgrade,
    success: "Refreshed Claude Code's /model picker from the live catalog — restart Claude Code to pick it up.",
    failure: "Couldn't refresh Claude Code's /model picker — re-run nexus claude on.",
  },
  {
    run: migrateClaudeFirerouterOnUpgrade,
    success: "FireRouter is now Nexus Auto: moved Claude Code to `auto`. Restart Claude Code to pick it up.",
    failure: "Couldn't move Claude Code from FireRouter to Nexus Auto. Re-run nexus claude on.",
  },
  {
    run: migrateCopilotCliFirerouterOnUpgrade,
    success: "FireRouter is now Nexus Auto: moved the Copilot CLI to `auto`. Start a new copilot session to pick it up.",
    failure: "Couldn't move the Copilot CLI from FireRouter to Nexus Auto. Re-run nexus copilot-cli on.",
  },
  {
    run: migrateVscodeFirerouterOnUpgrade,
    success: "FireRouter is now Nexus Auto: removed the FireRouter rows from VS Code's model list. Use `auto` instead. Restart VS Code to pick it up.",
    failure: "Couldn't remove the FireRouter rows from VS Code. Quit VS Code, then re-run nexus update.",
    skipped: "Didn't remove the FireRouter rows from VS Code while it's open — the update continues; quit VS Code, then run `nexus vscode` to remove them.",
  },
  {
    run: migrateCopilotAppFirerouterOnUpgrade,
    success: "FireRouter is now Nexus Auto: removed the FireRouter rows from the Copilot app's model list. Use `auto` instead. Restart the Copilot app to pick it up.",
    failure: "Couldn't remove the FireRouter rows from the Copilot app. Quit it, then re-run nexus update.",
    skipped: "Didn't remove the FireRouter rows from the Copilot app while it's open — the update continues; quit it, then run `nexus copilot-app` to remove them.",
  },
  {
    run: migrateCursorFirerouterOnUpgrade,
    success: "FireRouter is now Nexus Auto: moved Cursor to `nexus/auto`. Quit and reopen Cursor to pick it up.",
    failure: "Couldn't move Cursor from FireRouter to Nexus Auto. Quit Cursor, then re-run nexus update.",
    skipped: "Didn't move Cursor from FireRouter to Nexus Auto while Cursor is open — the update continues; quit Cursor, then run `nexus cursor` to apply it.",
  },
  {
    run: migrateDeepseekFirerouterOnUpgrade,
    success: "FireRouter is now Nexus Auto: moved DeepSeek Harness to `auto`. Restart dsh to pick it up.",
    failure: "Couldn't move DeepSeek Harness from FireRouter to Nexus Auto. Re-run nexus deepseek on.",
  },
  {
    run: migrateClaudeBakedAnthropicKeyOnUpgrade,
    success: "Removed the Anthropic key an earlier FireConnect copied into Claude Code's settings from your environment. Claude Code keeps using your Claude login, or ANTHROPIC_API_KEY if you export it. Restart Claude Code to pick it up.",
    failure: "Couldn't remove the Anthropic key an earlier FireConnect copied into Claude Code's settings. Re-run nexus claude on.",
  },
  {
    run: migrateEnvProviderKeyRefsOnUpgrade,
    success: "Nexus CLI no longer reads ANTHROPIC_API_KEY or OPENAI_API_KEY from your environment, so it cleared those references from ~/.nexus/config.json. To let Nexus Auto use your own key, run `nexus auto --anthropic-api-key` (or `--openai-api-key`) and paste at the prompt.",
    failure: "Couldn't clear the environment key references from ~/.nexus/config.json. Run `nexus auto --unset anthropic-api-key` (or `openai-api-key`).",
  },
  {
    run: migrateLegacyRouterAnthropicProviderOnUpgrade,
    success: "Removed the retired FireRouter setup an earlier FireConnect wrote into OpenCode's or Pi's Anthropic provider, including its ANTHROPIC_API_KEY reference. Restart them to pick it up.",
    failure: "Couldn't remove the retired FireRouter setup from OpenCode's or Pi's Anthropic provider. Run `nexus opencode off` or `nexus pi off`, then turn it on again.",
  },
  {
    run: migrateClaudeDesktopFirerouterOnUpgrade,
    success: "FireRouter is now Nexus Auto: removed the FireRouter rows from Claude Desktop's picker. Use `auto` instead. Restart Claude Desktop to pick it up.",
    failure: "Couldn't remove the FireRouter rows from Claude Desktop. Re-run nexus claude-desktop on.",
  },
  {
    run: restartClaudeDesktopShimOnUpgrade,
    success: "Restarted the Claude Desktop shim so this update (including Nexus Auto scope and saved keys) takes effect.",
    failure: "Couldn't restart the Claude Desktop shim. Run `nexus claude-desktop` to apply this update.",
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
      `Removed the deprecated routing preference from ${joinLabels(updated)}: Nexus Auto takes effort from your harness instead. `
        + `Restart ${updated.length > 1 ? "them" : "it"} to pick it up.`,
    );
  }
  return notes;
}

const NEXUS_AUTO_MOVE_PREFIX = "FireRouter is now Nexus Auto: ";

/** Heading for the per-harness moves off FireRouter, printed once per upgrade. */
export const NEXUS_AUTO_MOVES_HEADING = "Nexus Auto replaces FireRouter:";

/** @param {string} note */
export function isNexusAutoMoveNote(note) {
  return typeof note === "string" && note.startsWith(NEXUS_AUTO_MOVE_PREFIX);
}

/**
 * One block for every harness an upgrade moved off FireRouter, so the
 * rename isn't repeated per harness.
 * @param {string[]} moves notes for which {@link isNexusAutoMoveNote} is true
 */
export function formatNexusAutoMoves(moves) {
  const lines = moves.map((note) => {
    const rest = note.slice(NEXUS_AUTO_MOVE_PREFIX.length);
    return `  - ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  });
  return [NEXUS_AUTO_MOVES_HEADING, ...lines].join("\n");
}

async function migrationNote({ run, success, failure, skipped }, home) {
  try {
    return await run(home) ? success : "";
  } catch (error) {
    if (skipped && isMigrationSkipped(error)) {
      return skipped;
    }
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
