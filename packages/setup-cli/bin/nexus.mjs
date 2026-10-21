#!/usr/bin/env node

import "../lib/system/legacy-env.mjs";
import process from "node:process";

import {
  cliDependenciesMissingMessage,
  ensureCliDependencies,
} from "../lib/system/ensure-cli-deps.mjs";

/*
 * `node:sqlite` (used for Cursor/VS Code `state.vscdb`) emits an
 * ExperimentalWarning on import under Node >= 22. The installed launcher passes
 * `--disable-warning=ExperimentalWarning`, but running this file directly
 * (`node bin/nexus.mjs`, e.g. a dev alias) does not — and the warning
 * lands in the middle of interactive output like the uninstall checklist.
 *
 * Two details make this the shape it is:
 *  - It must be a persistent listener, not a window around the import.
 *    `process.emitWarning` defers to `process.nextTick`, so a local
 *    suppress-then-restore always restores before the warning fires.
 *  - Node's default printer is itself a 'warning' listener, and adding one
 *    does not replace it. So drop the existing listeners and become the only
 *    one, then re-print everything we don't filter in Node's default format.
 */
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /\bSQLite\b/i.test(warning.message)) {
    return;
  }
  process.stderr.write(`(node:${process.pid}) ${warning.name}: ${warning.message}\n`);
});

async function run() {
  if (!ensureCliDependencies()) {
    process.stderr.write(`${cliDependenciesMissingMessage()}\n`);
    process.exitCode = 1;
    return;
  }

  const { ROUTING_PREFERENCE_DEPRECATION_MESSAGE, parseCli } = await import("../lib/cli/parse-args.mjs");
  const parsed = parseCli(process.argv.slice(2));
  const {
    dataDirMigrationNote,
    markDataDirNoteShown,
    migrateLegacyDataDir,
    renameMigrationIncomplete,
  } = await import("../lib/system/data-dir.mjs");
  const dataDirStatus = migrateLegacyDataDir(parsed.ctx?.home || process.env.HOME || "");
  const dataDirNote = dataDirMigrationNote(dataDirStatus);
  if (dataDirStatus === "foreign") {
    // Any command would write this CLI's files into the other program's directory.
    process.stderr.write(`${dataDirNote}\n`);
    process.exitCode = 1;
    return;
  }
  if (dataDirNote) {
    process.stderr.write(`${dataDirNote}\n`);
    markDataDirNoteShown(dataDirNote);
  }

  // Upgraders before 0.8 only reset the checkout, an upgrade can be
  // interrupted before finalize, and a step can fail, so any command retries
  // the rename until every step has succeeded once. update and
  // finalize-install run it themselves.
  const home = parsed.ctx?.home || process.env.HOME || "";
  const finishesRenameItself = parsed.kind === "global"
    && ["update", "upgrade", "finalize-install", "uninstall"].includes(parsed.command);
  const { hasOwnedLegacyLauncher } = await import("../lib/system/launchers.mjs");
  const legacyLauncher = !finishesRenameItself && hasOwnedLegacyLauncher(home);
  if (!finishesRenameItself && (legacyLauncher || renameMigrationIncomplete(home))) {
    try {
      const { runRenameMigration } = await import("../lib/system/rename-migration.mjs");
      const notes = await runRenameMigration(home);
      if (notes.length > 0) {
        const replaced = legacyLauncher && !hasOwnedLegacyLauncher(home);
        const heading = replaced ? "FireConnect is now Nexus; use `nexus` from now on.\n" : "";
        process.stderr.write(`${heading}${notes.join("\n")}\n\n`);
      }
    } catch {
      // Nothing is marked complete, so the next command retries.
    }
  }

  const { runGlobalCommand } = await import("../lib/cli/commands/global.mjs");
  const { runHarnessCommand } = await import("../lib/cli/commands/harness.mjs");
  const { runDemoCommand } = await import("../lib/demo/command.mjs");
  const { checkForUpdates } = await import("../lib/system/update-notify.mjs");

  if (parsed.ctx?.routingPreferenceDeprecated) {
    const { warn } = await import("../lib/ui/index.mjs");
    warn(ROUTING_PREFERENCE_DEPRECATION_MESSAGE);
  }

  if (parsed.kind === "global") {
    await runGlobalCommand(parsed);
    await checkForUpdates(parsed.command, parsed.ctx.home);
    return;
  }

  if (parsed.kind === "harness") {
    await runHarnessCommand(parsed.route, parsed.ctx);
    await checkForUpdates("harness", parsed.ctx.home);
    return;
  }

  if (parsed.kind === "demo") {
    if (parsed.deprecated) {
      const { warn } = await import("../lib/ui/index.mjs");
      warn("`nexus demo` is deprecated. Use `nexus claude demo` instead.");
      console.log("Run `nexus claude demo` to race two models — see `nexus claude demo --help` for options.");
      return;
    }
    await runDemoCommand(parsed.ctx);
    return;
  }

  throw new Error("Internal error: unknown parse result");
}

run().catch(async (err) => {
  if (ensureCliDependencies()) {
    const { error } = await import("../lib/ui/index.mjs");
    error(err.message);
  } else {
    process.stderr.write(`${err.message}\n`);
  }
  if (process.env.FC_DEBUG) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
