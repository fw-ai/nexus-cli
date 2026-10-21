import process from "node:process";
import { listHarnesses } from "../../harness/registry.mjs";
import { detectInstalledHarnesses } from "../../harness/detect.mjs";
import { readGlobalConfig } from "../../config/global-config.mjs";
import { promptSelect } from "../../ui/prompt.mjs";
import { accent, bold, dim, cyan } from "../../ui.mjs";
import { readLocalVersion } from "../../system/version.mjs";
import { runHarnessCommand } from "./harness.mjs";
import { printHelp } from "./global.mjs";

/**
 * Status column for the harness list. From the global config + disk probes
 * only — cheap and synchronous. Per-harness model detail stays in `status`.
 *
 * @param {{ enabled?: boolean } | undefined} entry
 * @param {boolean} detected
 */
export function harnessStatusText(entry, detected) {
  if (entry?.enabled) {
    return cyan("on");
  }
  if (entry) {
    return dim("off");
  }
  return detected ? dim("off · detected") : dim("not detected");
}

/**
 * Level-1 choices: one row per harness, then the global commands.
 *
 * @param {import("../../harness/types.mjs").HarnessAdapter[]} adapters
 * @param {Record<string, { enabled?: boolean }>} harnessMap
 * @param {string[]} detectedIds
 */
export function buildLauncherChoices(adapters, harnessMap, detectedIds) {
  const detected = new Set(detectedIds);
  const idWidth = Math.max(...adapters.map((adapter) => adapter.id.length), "configure".length);
  const labelWidth = Math.max(...adapters.map((adapter) => adapter.label.length));

  const rows = adapters.map((adapter) => ({
    value: { kind: "harness", id: adapter.id },
    short: adapter.id,
    name: `${adapter.id.padEnd(idWidth)}  ${dim(adapter.label.padEnd(labelWidth))}  ${harnessStatusText(harnessMap[adapter.id], detected.has(adapter.id))}`,
  }));

  rows.push({
    value: { kind: "configure" },
    short: "configure",
    name: `${"configure".padEnd(idWidth)}  ${dim("choose Fireworks/Azure provider and BYOK keys")}`,
  });
  rows.push({
    value: { kind: "key" },
    short: "key",
    name: `${"key".padEnd(idWidth)}  ${dim("manage the Fireworks API key")}`,
  });
  rows.push({
    value: { kind: "help" },
    short: "help",
    name: `${"help".padEnd(idWidth)}  ${dim("full command reference")}`,
  });

  return rows;
}

/**
 * Level-2 choices for a harness. Values mirror the route shapes
 * `parseHarnessRoute` produces so dispatch stays identical to the direct CLI.
 *
 * @param {import("../../harness/types.mjs").HarnessAdapter} adapter
 * @param {boolean} enabled
 */
export function buildActionChoices(adapter, enabled) {
  const action = (label, detail, verb, noun = "") => ({
    value: { verb, noun },
    short: label,
    name: `${label.padEnd(14)}${dim(detail)}`,
  });
  const actions = [
    action("on", enabled ? `re-apply Fireworks routing for ${adapter.label}` : `route ${adapter.label} through Fireworks`, "on"),
    action("off", "restore your previous provider", "off"),
    action("status", "show provider, auth, and models", "status"),
  ];
  if (typeof adapter.usage === "function") {
    actions.splice(3, 0, action("usage", "estimate session usage cost", "usage"));
  }
  if (typeof adapter.live === "function") {
    actions.splice(typeof adapter.usage === "function" ? 4 : 3, 0, action("live", "Claude + live usage meter (tmux)", "live"));
  }
  return actions;
}

const KEY_CHOICES = [
  { value: "status", short: "status", name: `${"status".padEnd(10)}${dim("sign-in state and key storage")}` },
  { value: "set", short: "set", name: `${"set".padEnd(10)}${dim("sign in or rotate the Fireworks key")}` },
  { value: "export", short: "export", name: `${"export".padEnd(10)}${dim("print the resolved key to stdout")}` },
  { value: "delete", short: "delete", name: `${"delete".padEnd(10)}${dim("clear stored credentials (logout)")}` },
];

/**
 * @param {string} subcommand
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @returns {Promise<string>} direct CLI equivalent for teachFastPath
 */
async function dispatchKeyAction(subcommand, ctx) {
  const home = ctx.home || process.env.HOME || "";
  switch (subcommand) {
    case "status": {
      const { runStatusCommand } = await import("./status.mjs");
      await runStatusCommand(ctx);
      return "nexus status";
    }
    case "set": {
      const { runLoginCommand } = await import("./login.mjs");
      await runLoginCommand(ctx);
      return "nexus login";
    }
    case "export": {
      const { runKeyCommand } = await import("./key.mjs");
      await runKeyCommand(ctx, "export");
      return "nexus key export";
    }
    case "delete": {
      const { runLogoutCommand } = await import("./login.mjs");
      await runLogoutCommand(ctx);
      return "nexus logout";
    }
    default:
      throw new Error(`Unknown key operation: ${subcommand}`);
  }
}

function teachFastPath(output, command) {
  output.write(`\n${dim("next time, skip the menu:")} ${accent(command, output)}\n`);
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {{
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 *   dispatchHarness?: typeof runHarnessCommand,
 *   runConfigure?: () => Promise<void>,
 *   runKey?: (subcommand: string) => Promise<string>,
 * }} [overrides] test seams; production callers pass nothing.
 */
export async function runLauncherCommand(ctx, overrides = {}) {
  const input = overrides.input ?? process.stdin;
  const output = overrides.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    printHelp();
    return;
  }

  const home = ctx.home || process.env.HOME || "";
  const harnessMap = home ? (await readGlobalConfig(home)).harnesses ?? {} : {};
  const detectedIds = home ? detectInstalledHarnesses(home) : [];
  const adapters = listHarnesses();

  const version = readLocalVersion();
  output.write(`${bold(accent("nexus", output))}${version ? dim(` v${version}`) : ""}  ${dim("Fireworks routing for your coding harnesses")}\n\n`);

  const dispatchHarness = overrides.dispatchHarness ?? runHarnessCommand;
  const runConfigure = overrides.runConfigure ?? (async () => {
    const { runConfigureCommand } = await import("./configure.mjs");
    await runConfigureCommand(ctx);
  });
  const runKey = overrides.runKey ?? (async (subcommand) => {
    const command = await dispatchKeyAction(subcommand, ctx);
    return command;
  });

  // Esc on an inner menu returns here; Esc on this menu exits.
  for (;;) {
    const picked = await promptSelect({
      message: "Pick a harness or command",
      choices: buildLauncherChoices(adapters, harnessMap, detectedIds),
      pageSize: adapters.length + 3,
      input,
      output,
    });
    if (picked === null) {
      output.write(`${dim("Cancelled.")}\n`);
      return;
    }

    if (picked.kind === "help") {
      printHelp();
      return;
    }

    if (picked.kind === "configure") {
      await runConfigure();
      teachFastPath(output, "nexus configure");
      return;
    }

    if (picked.kind === "key") {
      const subcommand = await promptSelect({
        message: "key — pick an operation",
        choices: KEY_CHOICES,
        input,
        output,
      });
      if (subcommand === null) {
        continue;
      }
      const directCommand = await runKey(subcommand);
      if (directCommand) {
        teachFastPath(output, directCommand);
      }
      return;
    }

    const adapter = adapters.find((candidate) => candidate.id === picked.id);
    const action = await promptSelect({
      message: `${picked.id} — pick an action`,
      choices: buildActionChoices(adapter, harnessMap[picked.id]?.enabled === true),
      input,
      output,
    });
    if (action === null) {
      continue;
    }

    const route = { harnessId: picked.id, verb: action.verb, noun: action.noun };
    await dispatchHarness(route, ctx);
    const directCommand = action.verb === "on" && !action.noun
      ? `nexus ${picked.id}`
      : `nexus ${picked.id}${action.noun ? ` ${action.noun}` : ""} ${action.verb}`;
    teachFastPath(output, directCommand);
    return;
  }
}
