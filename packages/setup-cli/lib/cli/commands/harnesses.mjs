import process from "node:process";
import { HARNESS_COMMANDS, resolveHarnessAlias } from "../../harness/id.mjs";
import { listRoutedHarnessIds } from "../../harness/registry.mjs";
import { formatOnOff, printSectionHeader } from "../../harness/status-display.mjs";
import { printBody, printCommandHint } from "../messages.mjs";
import { bold, dim } from "../../ui.mjs";

/**
 * Every harness command with whether its harness routes through Fireworks here.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {string} home
 */
export async function harnessRows(ctx, home) {
  const routed = new Set(await listRoutedHarnessIds(ctx, home));
  return HARNESS_COMMANDS.map(({ command, name }) => {
    const id = resolveHarnessAlias(command);
    return { id, command, name, connected: routed.has(id) };
  });
}

/**
 * Aligned `command  name  on/off  installed` rows. The on/off column is left
 * out when rows carry no `connected`, and the install column when they carry
 * no `installed`.
 * @param {Array<{ command: string, name: string, connected?: boolean, installed?: boolean }>} rows
 * @param {{ indent?: string, style?: (text: string) => string }} [options]
 */
export function printHarnessRows(rows, { indent = "  ", style = bold } = {}) {
  const commandWidth = Math.max(...rows.map((row) => row.command.length));
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const showInstalled = rows.some((row) => row.installed !== undefined);
  for (const { command, name, connected, installed } of rows) {
    const columns = connected === undefined ? [name] : [name.padEnd(nameWidth), formatOnOff(connected)];
    if (showInstalled) {
      // `off` is the wider on/off value; pad so the install column lines up.
      if (connected !== undefined) columns[1] = `${columns[1]}${" ".repeat(connected ? 1 : 0)}`;
      columns.push(installed ? "installed" : dim("not detected"));
    }
    console.log(`${indent}${[style(command.padEnd(commandWidth)), ...columns].join("  ")}`.trimEnd());
  }
}

export const HARNESSES_DEPRECATION_MESSAGE =
  "`nexus harnesses` is deprecated: `nexus status` lists every harness with whether it's on and installed.";

/**
 * `nexus harnesses`: every supported harness, and whether it is on here.
 * Deprecated in favor of `nexus status`; it keeps working (stdout unchanged,
 * so `--json` scripts don't break) and says so on stderr.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runHarnessesCommand(ctx) {
  process.stderr.write(`${HARNESSES_DEPRECATION_MESSAGE}\n`);
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }
  const rows = await harnessRows(ctx, home);

  if (ctx.json) {
    console.log(JSON.stringify({ harnesses: rows }, null, 2));
    return;
  }

  console.log("");
  printBody("Every harness Nexus CLI can route through Fireworks. On means it already does on this machine.");
  console.log("");
  printSectionHeader("Harnesses");
  printHarnessRows(rows);
  console.log("");
  printCommandHint("Connect one", "nexus <harness>");
  printCommandHint("See its options", "nexus <harness> help");
}
