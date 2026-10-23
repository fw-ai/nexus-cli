import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_DATA_DIR,
} from "../../harnesses/claude/core.mjs";
import {
  OPENCODE_DATA_RELATIVE_DIR,
} from "../../harnesses/opencode/core.mjs";
import {
  CODEX_CATALOG_RELATIVE_PATH,
  CODEX_DATA_RELATIVE_DIR,
  codexConfigPath,
  snapshotReferencesFireworksCatalog,
} from "../../harnesses/codex/core.mjs";
import {
  DEEPSEEK_DATA_RELATIVE_DIR,
} from "../../harnesses/deepseek/constants.mjs";
import {
  PI_DATA_RELATIVE_DIR,
} from "../../harnesses/pi/core.mjs";
import {
  CURSOR_DATA_RELATIVE_DIR,
  CURSOR_FIREWORKS_ONLY_NOTE,
} from "../../harnesses/cursor/core.mjs";
import {
  VSCODE_DATA_RELATIVE_DIR,
} from "../../harnesses/vscode/core.mjs";
import { WORKSPACE_NOTES as CLAUDE_DESKTOP_WORKSPACE_NOTES } from "../../harnesses/claude-desktop/core.mjs";
import { COPILOT_DATA_RELATIVE_DIR as COPILOT_APP_DATA_RELATIVE_DIR } from "../../harnesses/copilot-app/core.mjs";
import { COPILOT_CLI_DATA_RELATIVE_DIR } from "../../harnesses/copilot-cli/config.mjs";
import { globalConfigPath } from "../../config/global-config.mjs";
import { getHarness, listRoutedHarnessIds } from "../../harness/registry.mjs";
import { HARNESS, HARNESS_COMMANDS } from "../../harness/id.mjs";
import { runConfigureCommand } from "./configure.mjs";
import { runAutoCommand } from "./auto.mjs";
import { runHarnessesCommand } from "./harnesses.mjs";
import { runGlobalModelListCommand } from "./model.mjs";
import { printReleaseNotesAfterUpgrade } from "../../system/release-notes.mjs";
import { readLocalVersion } from "../../system/version.mjs";
import { removeShellEnvHook } from "../../io/shell-env-hook.mjs";
import { runClaudeUpgradePreflight } from "../../system/upgrade.mjs";
import { finalizeInstallOrUpgrade } from "../../system/finalize-install.mjs";
import { runUpgradeFinalize } from "../../system/upgrade-finalize.mjs";
import { runtimeDepsInstalled } from "../../system/ensure-cli-deps.mjs";
import { COMMAND, ownedLaunchers } from "../../system/launchers.mjs";
import {
  DATA_DIRNAME,
  hasForeignDataDir,
  LEGACY_ASIDE_DIRNAME,
  LEGACY_DATA_DIRNAME,
} from "../../system/data-dir.mjs";
import { deleteSecret } from "../../keys/secret-store.mjs";
import { demoHelpText } from "../../demo/help.mjs";
import { info, printBanner, success } from "../../ui/index.mjs";
import { colorizeHelp } from "../../ui.mjs";
import { accent, check as checkGlyph, red, symbols } from "../../ui/style.mjs";

/**
 * Per-harness Nexus data dir (`~/.nexus/<id>`), holding the
 * snapshot/backup `off` needs to restore. Deleting a harness's dir only after
 * its `off` succeeds keeps restore recoverable if a later step fails.
 * @type {Record<string, string>}
 */
const HARNESS_DATA_DIR = {
  [HARNESS.CLAUDE]: DEFAULT_DATA_DIR,
  [HARNESS.OPENCODE]: OPENCODE_DATA_RELATIVE_DIR,
  [HARNESS.CODEX]: CODEX_DATA_RELATIVE_DIR,
  [HARNESS.PI]: PI_DATA_RELATIVE_DIR,
  [HARNESS.DEEPSEEK]: DEEPSEEK_DATA_RELATIVE_DIR,
  [HARNESS.CURSOR]: CURSOR_DATA_RELATIVE_DIR,
  [HARNESS.VSCODE]: VSCODE_DATA_RELATIVE_DIR,
  [HARNESS.COPILOT_APP]: COPILOT_APP_DATA_RELATIVE_DIR,
  [HARNESS.COPILOT_CLI]: COPILOT_CLI_DATA_RELATIVE_DIR,
};

const CLI_NAME = COMMAND;

function helpLines(...lines) {
  return lines.join("\n");
}

function cmdBlock(title, entries) {
  const width = Math.max(14, ...entries.map(([name]) => name.length + 2));
  const body = entries.map(([name, desc]) => `  ${name.padEnd(width)}${desc}`).join("\n");
  return `${title}:\n${body}`;
}

function optBlock(title, entries) {
  const body = entries.map(([flag, desc]) => `  ${flag.padEnd(26)}${desc}`).join("\n");
  return `${title}:\n${body}`;
}

const HARNESS_NAME = Object.fromEntries(HARNESS_COMMANDS.map(({ command, name }) => [command, name]));
const HARNESS_ROWS = Object.entries(HARNESS_NAME);

const OPT_HOME = ["--home <path>", "Override HOME for config resolution."];
const OPT_DATA_DIR = ["--data-dir <path>", "Override backup/state directory."];

const OPT_SKIP_INSTALL_CHECK = ["--skip-install-check", "Turn on even when the harness doesn't look installed."];

/**
 * Options for `<harness> on`. Provider keys for Nexus Auto are not harness
 * options: `nexus auto --anthropic-api-key` / `--openai-api-key` saves them
 * once for every harness that can send them.
 */
function standardOnOpts({ azure = true, modelNote = "" } = {}) {
  const opts = [
    ["--api-key <key>", "Fireworks API key (on also saves config when set)."],
  ];
  if (azure) {
    opts.push(
      ["--azure", "Route through Microsoft Foundry endpoint."],
      ["--base-url <url>", "Microsoft Foundry endpoint (with --azure)."],
    );
  }
  opts.push(["--model <id>", `Model to use${modelNote ? ` (${modelNote})` : ""}.`]);
  opts.push(OPT_SKIP_INSTALL_CHECK);
  return opts;
}

function claudeHelp() {
  return helpLines(
    `Usage: ${CLI_NAME} claude [command] [options]`,
    "",
    "Route Claude Code through Fireworks. Bare `nexus claude` runs on.",
    "",
    cmdBlock("Commands", [
      ["on", "Enable Fireworks routing (default)."],
      ["off", "Restore your previous Claude Code settings."],
      ["status", "Show provider, auth, and model mapping."],
      ["usage", "Pick session → live meter (Tab for the agents pane); snapshot with --json / --last-n."],
      ["demo", "Race two models on a prompt (requires claude on)."],
      ["help", "Show this help."],
    ]),
    "",
    optBlock("Options for on", [
      ["--api-key <key>", "Fireworks API key (also saves ~/.nexus/config.json)."],
      ["--base-url <url>", "Anthropic-compatible gateway URL override."],
      ["--model <id>", "Add a Fireworks model to Claude Code's /model picker (default)."],
      ["--opus <id>", "Pin the Opus tier slot (`native` = Claude default)."],
      ["--sonnet <id>", "Pin the Sonnet tier slot (`native` = Claude default)."],
      ["--haiku <id>", "Pin the Haiku tier slot (`native` = Claude default)."],
      ["--fable <id>", "Pin the Fable tier slot (`native` = Claude default)."],
      ["--subagent <id>", "Pin the subagent model (`native` = Claude default)."],
      ["--non-interactive", "Non-interactive connect (default)."],
      OPT_SKIP_INSTALL_CHECK,
    ]),
    "",
    optBlock("Options for usage", [
      ["--session <id|path>", "Start on one session; Esc still opens the session list."],
      ["--days <N>", "Lookback for the session list, 1-365 (default 3)."],
      ["--last-n <N>", "Snapshot of the latest N parent sessions."],
      ["--plain", "Plain text summary (no interactive TUI styling)."],
      ["-v, --verbose", "Request-level usage rows and rate details."],
    ]),
    "",
    optBlock("Options for status, usage", [
      ["--json", "Machine-readable JSON output."],
    ]),
    "",
    `Run \`${CLI_NAME} help demo\` for demo-specific options.`,
    "",
    optBlock("Options for all commands", [
      OPT_HOME,
      ["--settings-path <path>", "Explicit Claude Code settings file."],
      OPT_DATA_DIR,
    ]),
  );
}

function configHarnessHelp(id, label, { configPath, configPathNote = "", codexNote = "", displayId = id, force = false } = {}) {
  const onOpts = standardOnOpts({
    azure: Boolean(getHarness(id).azure),
    modelNote: id === "deepseek" ? "default: auto" : id === "codex" ? "default: auto; a re-on keeps the current model" : "",
  });
  if (force) {
    onOpts.push(["--force", "Write while the ChatGPT app is running (not recommended)."]);
  }
  const allOpts = [
    OPT_HOME,
    [configPath, configPathNote || "Explicit config file path."],
    OPT_DATA_DIR,
  ].filter((row) => row[0]);

  return helpLines(
    `Usage: ${CLI_NAME} ${displayId} [command] [options]`,
    "",
    `Route ${label} through Fireworks. Bare \`${CLI_NAME} ${displayId}\` runs on.`,
    codexNote ? `\n${codexNote}` : "",
    "",
    cmdBlock("Commands", [
      ["on", "Enable Fireworks routing (default)."],
      ["off", "Restore your previous config."],
      ["status", "Show provider, auth, and model."],
      ["help", "Show this help."],
    ]),
    "",
    optBlock("Options for on", onOpts),
    "",
    optBlock("Options for status", [
      ["--json", "Machine-readable JSON output."],
    ]),
    "",
    optBlock("Options for all commands", allOpts),
  );
}

function ideHarnessHelp(id, label, { pathFlag, pathDesc, note }) {
  const onOpts = standardOnOpts({ azure: Boolean(getHarness(id).azure) });
  onOpts.push(["--force", `Write while ${label} is running (not recommended).`]);

  return helpLines(
    `Usage: ${CLI_NAME} ${id} [command] [options]`,
    "",
    `Route ${label} through Fireworks. Bare \`${CLI_NAME} ${id}\` runs on.`,
    "",
    note,
    "",
    cmdBlock("Commands", [
      ["on", "Enable Fireworks routing (default)."],
      ["off", "Restore your previous settings."],
      ["status", "Show provider, auth, and models."],
      ["help", "Show this help."],
    ]),
    "",
    optBlock("Options for on", onOpts),
    "",
    optBlock("Options for status", [
      ["--json", "Machine-readable JSON output."],
    ]),
    "",
    optBlock("Options for all commands", [
      OPT_HOME,
      [pathFlag, pathDesc],
    ]),
  );
}

export function mainCommandsHelp() {
  return helpLines(
    "Nexus CLI: use Fireworks models in AI coding tools.",
    "",
    cmdBlock("Get started", [
      ["login", "Sign in to Fireworks."],
      ["claude", "Route Claude Code through Fireworks."],
    ]),
    "",
    cmdBlock("Harnesses", HARNESS_ROWS),
    "",
    cmdBlock("Per harness", [
      ["<harness> on", "Enable Fireworks routing (default)."],
      ["<harness> off", "Restore previous settings."],
      ["<harness> status", "Show provider, auth, and models."],
    ]),
    "",
    cmdBlock("Other", [
      ["status", "Sign-in state, key storage, and each harness (on/off, installed)."],
      ["configure", "Provider (Fireworks or Microsoft Foundry)."],
      ["auto", "Customize the auto router: providers, and Anthropic and OpenAI keys."],
      ["update", "Update Nexus CLI."],
      ["help", "Full command reference."],
      ["help <harness>", "All options for one harness."],
    ]),
  );
}

export function printHelp(topic = "") {
  if (topic === "quick") {
    console.log(colorizeHelp(mainCommandsHelp()));
    return;
  }

  const codexHelpOpts = {
    configPath: "--config-path <path>",
    configPathNote: "Explicit ~/.codex/config.toml path.",
    codexNote: "The Codex CLI and the ChatGPT desktop app share ~/.codex/config.toml, so "
      + "`nexus codex` and `nexus chatgpt` switch both.\n"
      + "GPT turns are paid by Codex's own sign-in (your ChatGPT plan, or an OpenAI key from "
      + "`codex login --with-api-key`), else by an OpenAI Provider Key on your Fireworks account.",
    force: true,
  };
  const harnessHelp = {
    claude: claudeHelp(),
    opencode: configHarnessHelp("opencode", "OpenCode", {
      configPath: "--config-path <path>",
      configPathNote: "Explicit opencode.json path.",
    }),
    codex: configHarnessHelp("codex", HARNESS_NAME.codex, codexHelpOpts),
    // `chatgpt` is an alias for the codex harness; same help, typed name in the usage line.
    chatgpt: configHarnessHelp("codex", HARNESS_NAME.chatgpt, { ...codexHelpOpts, displayId: "chatgpt" }),
    pi: helpLines(
      configHarnessHelp("pi", "Pi", {
        configPath: "--settings-path <path>",
        configPathNote: "Explicit Pi settings.json path.",
      }),
      "",
      "  --config-path <path>      Alias for --settings-path.",
    ),
    cursor: ideHarnessHelp("cursor", "Cursor", {
      pathFlag: "--db-path <path>",
      pathDesc: "Explicit Cursor state.vscdb path.",
      note: "Quit Cursor before on/off (Cmd-Q). status is read-only. "
        + `${CURSOR_FIREWORKS_ONLY_NOTE}`,
    }),
    vscode: ideHarnessHelp("vscode", "VS Code Chat", {
      pathFlag: "--vscode-path <path>",
      pathDesc: "Explicit chatLanguageModels.json path.",
      note: "If VS Code is running, on/off wait for you to quit (press Enter or auto-detect). Restart after. status is read-only.",
    }),
    "copilot-app": ideHarnessHelp("copilot-app", "Copilot app", {
      pathFlag: "--db-path <path>",
      pathDesc: "Explicit Copilot data.db path (default: ~/.copilot/data.db).",
      note: "Adds a Fireworks BYOK provider to the GitHub Copilot desktop app; its built-in "
        + "models keep working. Quit the app before on/off (Cmd-Q). status is read-only. "
        + "For the `copilot` command-line tool, use `nexus copilot-cli`.",
    }),
    "copilot-cli": helpLines(
      configHarnessHelp("copilot-cli", "Copilot CLI", {
        configPath: "--providers-path <path>",
        configPathNote: "Explicit providers.json path (default: ~/.copilot/providers.json).",
      }),
      "",
      "Writes the Fireworks BYOK provider to providers.json and selects it in settings.json.",
      "The CLI addresses BYOK models by a provider-qualified id (fireworks/<model>); a bare",
      "id is rejected. Switch with `copilot --model fireworks/<id>` or `/model`.",
      "For the desktop app, use `nexus copilot-app`.",
    ),
    deepseek: configHarnessHelp("deepseek", "DeepSeek Harness (dsh)", {
      configPath: "--config-path <path>",
      configPathNote: "Explicit ~/.dsh/settings.yaml path.",
    }),
    "claude-desktop": helpLines(
      `Usage: ${CLI_NAME} claude-desktop <on|off|status> | mcp <list|add|remove|sync>`,
      "",
      "Routes Claude Desktop's Chat, Cowork and Code surfaces through Fireworks",
      "via Desktop's third-party inference profile and a loopback gateway",
      "shim (a launchd agent on macOS, a systemd user unit on Linux; both",
      "auto-restart). Connectors are imported from your existing",
      "setup; each needs a one-time re-auth, and some providers (Google, Figma",
      "hosted) need your own OAuth app or a companion local server.",
      "",
      "  on                 enable (idempotent; pre-existing profiles backed up).",
      "  off                restore the previous configuration.",
      "  status             lane health: shim, applied profile, connectors.",
      "",
      "  mcp list|add|remove|sync",
      "                     Manage connectors in the 3p profile. sync re-detects",
      "                     from Desktop sessions, the pre-Nexus CLI config, and",
      "                     the org's claude.ai connector registry (via the Claude",
      "                     Code CLI when installed).",
      "",
      "`off` restores only what Nexus CLI changed (profiles, device config,",
      "services) and removes only Nexus CLI-owned artifacts.",
      "Quit and reopen Claude Desktop after on/off.",
      "",
      "What stays with your claude.ai subscription:",
      ...CLAUDE_DESKTOP_WORKSPACE_NOTES.map((note) => `  - ${note}`),
      "",
      "Requirements: macOS or Linux, a stored Fireworks credential",
      "(`nexus login`). Linux support is unofficial: Anthropic documents",
      "third-party mode for macOS and Windows only.",
    ),
    login: helpLines(
      `Usage: ${CLI_NAME} login [options]`,
      "",
      "Sign in to Fireworks and store an API key in the OS keychain.",
      "",
      optBlock("Options", [
        ["--account <id>", "Enterprise SSO account id."],
        ["--with-token", "Read API key from stdin (CI/non-interactive)."],
        ["--paste", "Skip chooser and paste a key."],
        ["--api-key <key>", "Sign in with this key directly."],
        ["--force", "Skip the replace-key confirmation when already signed in (key rotation)."],
        OPT_HOME,
      ]),
    ),
    logout: helpLines(
      `Usage: ${CLI_NAME} logout [options]`,
      "",
      "Clear stored Fireworks credentials (does not unset FIREWORKS_API_KEY in your shell).",
      "",
      optBlock("Options", [
        ["--revoke", "Revoke this machine's key without prompting."],
      ]),
    ),
    status: helpLines(
      `Usage: ${CLI_NAME} status [options]`,
      "",
      "Show sign-in state (validated live), machine environment, key storage, per-harness key sources, and whether each harness is on and installed. Exits non-zero when signed out.",
      "",
      optBlock("Options", [
        ["--json", "Machine-readable JSON output."],
        OPT_HOME,
      ]),
    ),
    harnesses: helpLines(
      `Usage: ${CLI_NAME} harnesses [options]`,
      "",
      `Deprecated: \`${CLI_NAME} status\` lists every harness with whether it's on and installed.`,
      "",
      "List every supported harness and whether Nexus CLI has connected it on this machine.",
      "",
      optBlock("Options", [
        ["--json", "Machine-readable JSON output."],
        OPT_HOME,
      ]),
    ),
    configure: helpLines(
      `Usage: ${CLI_NAME} configure [options]`,
      "",
      "Set the default provider. Use `nexus login` for your Fireworks key, and `nexus auto` for Anthropic and OpenAI keys.",
      "",
      optBlock("Options", [
        ["--provider <name>", "fireworks (default) or azure."],
        ["--base-url <url>", "Foundry URL (with --provider azure)."],
        ["--api-key <key>", "Foundry endpoint key (azure only)."],
        ["--anthropic-api-key <key>", "Deprecated: use `nexus auto --anthropic-api-key`."],
        ["--openai-api-key <key>", "Deprecated: use `nexus auto --openai-api-key`."],
        ["--unset <key>", "Deprecated: use `nexus auto --unset <key>`."],
        OPT_HOME,
      ]),
    ),
    auto: helpLines(
      `Usage: ${CLI_NAME} auto [options]`,
      "",
      "Customize the auto router and save the Anthropic and OpenAI keys it may use.",
      "Bare `nexus auto` shows the current settings.",
      "",
      "In the default, Auto-selects the best model for each turn,",
      "based on your setup. Use this command to narrow that down:",
      "for example, to Fireworks-hosted models only. The change is global",
      "(not per harness): run it once, then run `nexus <harness>` again",
      "for each harness you use, so it takes effect there.",
      "",
      "Your account's model restrictions always apply first.",
      "",
      optBlock("Options", [
        ["--providers <list>", "Providers auto may route to, comma-separated (fireworks means models hosted on Fireworks; the only one supported today)."],
        ["--reset", "Remove the extra filter and go back to the default."],
        ["--anthropic-api-key <key>", "Save an Anthropic key so auto can use Anthropic models. Sent from every harness that can carry it; run `nexus <harness>` again to apply."],
        ["--openai-api-key <key>", "Save an OpenAI key so auto can use OpenAI models. Same reach as above."],
        ["--unset <key>", "Clear a saved key (anthropic-api-key or openai-api-key), here and in every harness."],
        ["--json", "Machine-readable output."],
        OPT_HOME,
      ]),
    ),
    demo: demoHelpText(CLI_NAME, { deprecatedTopLevel: true }),
    uninstall: helpLines(
      `Usage: ${CLI_NAME} uninstall`,
      "",
      "Disable all harnesses and remove Nexus CLI (~/.nexus/, CLI launcher).",
    ),
    update: helpLines(
      `Usage: ${CLI_NAME} update`,
      "",
      "Update Nexus CLI (curl/git install only). `upgrade` is an alias.",
    ),
  };
  harnessHelp.upgrade = harnessHelp.update;

  if (topic && harnessHelp[topic]) {
    console.log(colorizeHelp(harnessHelp[topic]));
    return;
  }

  console.log(colorizeHelp(helpLines(
    "Nexus CLI: use Fireworks models in AI coding tools.",
    "",
    `Usage: ${CLI_NAME} [<harness> [command]] [options]`,
    "",
    cmdBlock("Harnesses", HARNESS_ROWS),
    "",
    cmdBlock("Harness commands", [
      ["on", "Route the harness through Fireworks (default when omitted)."],
      ["off", "Restore previous provider settings."],
      ["status", "Show provider, auth, and models."],
      ["usage", "Claude-only: session usage report."],
      ["demo", "Claude-only: race two models on a prompt."],
      ["help", "Show harness-specific options."],
    ]),
    "",
    cmdBlock("Global commands", [
      ["login", "Sign in to Fireworks."],
      ["logout", "Clear stored credentials."],
      ["status", "Show sign-in state, environment, key storage, and each harness (on/off, installed)."],
      ["model list", "Browse serverless models."],
      ["models", "Alias for model list."],
      ["configure", "Set the provider (Fireworks or Microsoft Foundry)."],
      ["auto", "Customize the auto router: providers, and Anthropic and OpenAI keys."],
      ["update", "Update Nexus CLI."],
      ["upgrade", "Alias for update."],
      ["uninstall", "Remove Nexus CLI."],
      ["help", "Show help (`help <topic>` or `<harness> help`)."],
    ]),
    "",
    optBlock("Global options", [
      ["--version, -V", "Print CLI version (--json for machine-readable)."],
      ["--search <q>", "Filter model list."],
      ["--refresh", "Bypass the 1-hour cache and refetch (keeps cached data if offline)."],
      ["--json", "Machine-readable model list output."],
    ]),
    "",
    `Run \`${CLI_NAME} <harness> help\` for every option on that harness.`,
  )));
}

async function readInstalledVersion(installDir) {
  try {
    const raw = await readFile(path.join(installDir, "packages/setup-cli/package.json"), "utf8");
    return JSON.parse(raw).version ?? "";
  } catch {
    return "";
  }
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export function runVersionCommand(ctx) {
  const version = readLocalVersion();
  if (!version) {
    throw new Error("Unable to determine Nexus CLI version.");
  }

  if (ctx.json) {
    console.log(JSON.stringify({ version }, null, 2));
    return;
  }

  console.log(`v${version}`);
}

/**
 * Hidden easter-egg entry point — not listed in help. Use for local preview;
 * install.sh uses bin/nexus-banner.mjs directly.
 */
export function runBannerCommand() {
  printBanner({ version: readLocalVersion() || undefined });
}

/**
 * Hidden install.sh entry point — not listed in help. Same body as upgrade
 * finalize (deps, key-storage probe, harness migrations, key rebake).
 *
 * @param {{ home?: string }} [ctx]
 */
export async function runFinalizeInstallCommand(ctx = {}) {
  const home = ctx.home || process.env.HOME || "";
  const installDir = home ? path.join(home, DATA_DIRNAME, "cli") : "";
  const result = await finalizeInstallOrUpgrade({ home, installDir });
  if (result.renameBlocked) {
    throw new Error("Finalize stopped: rename or remove ~/.nexus, then run the update again.");
  }
}

/**
 * Dependencies are injectable so the fetch/compare/preflight/reset ordering can
 * be tested without a network or a real installation.
 *
 * @param {{
 *   home?: string,
 *   execFile?: typeof execFileSync,
 *   exists?: typeof existsSync,
 *   readVersion?: typeof readInstalledVersion,
 *   finalize?: typeof runUpgradeFinalize,
 *   printNotes?: typeof printReleaseNotesAfterUpgrade,
 *   preflight?: typeof runClaudeUpgradePreflight,
 *   getClaudeAdapter?: () => { off: (ctx: object) => Promise<void> },
 *   input?: NodeJS.ReadStream | { isTTY?: boolean },
 *   printBannerFn?: typeof printBanner,
 *   infoFn?: typeof info,
 *   successFn?: typeof success,
 *   log?: (...args: unknown[]) => void,
 *   runtimeDepsPresent?: (setupDir: string) => boolean,
 *   dataDirBlocked?: (home: string) => boolean,
 * }} [dependencies]
 */
export async function runUpgradeCommand({
  home = process.env.HOME ?? "",
  execFile = execFileSync,
  exists = existsSync,
  readVersion = readInstalledVersion,
  finalize = runUpgradeFinalize,
  printNotes = printReleaseNotesAfterUpgrade,
  preflight = runClaudeUpgradePreflight,
  getClaudeAdapter = () => getHarness(HARNESS.CLAUDE),
  input = process.stdin,
  printBannerFn = printBanner,
  infoFn = info,
  successFn = success,
  log = console.log,
  runtimeDepsPresent = runtimeDepsInstalled,
  dataDirBlocked = hasForeignDataDir,
} = {}) {
  if (!home) {
    throw new Error("HOME is not set; update requires HOME to be set.");
  }
  const installDir = path.join(home, DATA_DIRNAME, "cli");

  printBannerFn();

  // The rename to ~/.nexus is part of this update, and a ~/.nexus owned by
  // another program blocks it. Discover that before fetch/reset/npm — and
  // before any "Updated" output — so a blocked update changes nothing and
  // the installed version keeps working. (install.sh checks the same thing
  // before it changes anything.)
  if (dataDirBlocked(home)) {
    throw new Error(
      `Update stopped before changing anything: ~/${DATA_DIRNAME} belongs to another program, `
      + `so your FireConnect settings stay in ~/${LEGACY_DATA_DIRNAME}. `
      + `Rename or remove ~/${DATA_DIRNAME}, then run the update again.`,
    );
  }

  if (!exists(path.join(installDir, ".git"))) {
    infoFn("Nothing to update: Nexus CLI was not installed via the curl installer.");
    infoFn("Re-run the installer to get the latest version:");
    infoFn("  curl -fsSL https://nexus.fireworks.ai/install.sh | bash");
    await finalize(home, installDir);
    return;
  }

  const before = await readVersion(installDir);
  if (before) {
    infoFn(`Current version: v${before}`);
  }

  let beforeHash = "";
  try {
    beforeHash = execFile("git", ["-C", installDir, "rev-parse", "HEAD"], { stdio: "pipe", encoding: "utf8" }).trim();
  } catch { /* non-fatal */ }

  infoFn("Checking for updates...");
  let targetHash = "";
  try {
    execFile("git", ["-C", installDir, "fetch", "--depth=1", "origin", "main", "--quiet"], { stdio: "pipe" });
    targetHash = execFile("git", ["-C", installDir, "rev-parse", "FETCH_HEAD"], {
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() ?? error.message;
    throw new Error(`Update failed: ${detail}`);
  }

  if (!targetHash) {
    throw new Error("Update failed: unable to determine the fetched revision.");
  }

  const setupDir = path.join(installDir, "packages/setup-cli");
  const installRuntimeDeps = (lockfileChanged) => {
    // Reinstall after a lockfile change, and also when package.json deps are
    // missing (e.g. yaml added while git still reports no lockfile diff, or an
    // already-current checkout whose node_modules lagged a previous pull).
    const missing = exists(setupDir) && !runtimeDepsPresent(setupDir);
    if ((!lockfileChanged && !missing) || !exists(setupDir)) {
      return;
    }
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    try {
      execFile(npmBin, ["install", "--omit=dev", "--no-fund", "--no-audit"], {
        cwd: setupDir,
        env: { ...process.env, NEXUS_SKIP_POSTINSTALL_FINALIZE: "1" },
        stdio: "inherit",
      });
    } catch (error) {
      throw new Error(`Update failed: could not install dependencies (${error.message}). Re-run the installer.`);
    }
  };

  if (beforeHash && beforeHash === targetHash) {
    infoFn(`Already up to date${before ? ` (v${before})` : ""}.`);
    installRuntimeDeps(false);
    await finalize(home, installDir);
    await printNotes({
      home,
      fromVersion: "",
      toVersion: before,
      installDir,
    });
    return;
  }

  // The registry was loaded from the currently running revision. Capture that
  // adapter before reset so restoration cannot switch to newly fetched code.
  // Claude-off preflight only applies when upgrading from FireConnect < 0.9.0.
  const oldClaudeAdapter = getClaudeAdapter();
  const claudePreflight = await preflight({
    home,
    adapter: oldClaudeAdapter,
    input,
    installedVersion: before,
  });
  if (!claudePreflight.proceed) {
    infoFn("Update cancelled.");
    return;
  }

  try {
    execFile("git", ["-C", installDir, "reset", "--hard", targetHash], { stdio: "pipe" });
  } catch (error) {
    const detail = error.stderr?.toString().trim() ?? error.message;
    throw new Error(`Update failed: ${detail}`);
  }

  const afterHash = targetHash;
  const after = await readVersion(installDir);

  // Reinstall runtime dependencies after the pull — a new release may have
  // added/changed deps (e.g. yaml). Skip npm when the lockfile is unchanged
  // *and* every package.json dependency is already on disk.
  const lockfileRel = "packages/setup-cli/package-lock.json";
  let depsChanged = true;
  if (beforeHash && afterHash) {
    try {
      execFile("git", ["-C", installDir, "diff", "--quiet", beforeHash, afterHash, "--", lockfileRel], { stdio: "ignore" });
      depsChanged = false; // exit 0 => no diff
    } catch {
      depsChanged = true; // non-zero => diff (or git error) => install
    }
  }
  installRuntimeDeps(depsChanged);

  // Finalize first: it runs the rename and the harness migrations the new
  // version needs. Only once it completes is the update done, so success
  // and the release notes print after it, not before.
  await finalize(home, installDir);

  if (!claudePreflight.restored) {
    if (before && after && before !== after) {
      successFn(`Updated v${before} → v${after}.`);
    } else {
      successFn(`Nexus CLI updated successfully${after ? ` (v${after})` : ""}.`);
    }
  }

  await printNotes({
    home,
    fromVersion: before,
    toVersion: after,
    installDir,
  });

  if (claudePreflight.restored) {
    log("Update complete. Your original Claude Code settings were restored.");
    log(`To reconnect with Nexus CLI v${after || before || "unknown"}:\n  nexus claude`);
  }
}

async function removePath(pathToRemove) {
  try {
    await rm(pathToRemove, { recursive: true, force: true });
    return null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    return { path: pathToRemove, message: error.message };
  }
}

/**
 * Restore one harness's pre-Nexus config. Interactive uninstall calls
 * this per harness (without `force`) so Cursor/VS Code get the interactive
 * "quit the IDE" wait via their own `prepareOff`; non-interactive uninstall
 * passes `force: true` to skip the wait (CI/scripts). Errors are collected,
 * not thrown, so one harness failing doesn't abort the rest.
 *
 * `quiet` silences the harness's own restored/unchanged + restart-hint lines
 * (see `engineOff`) so the interactive checklist is the only narration; the
 * outcome is still returned so the checklist can say what actually happened.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {string} home
 * @param {string} harnessId
 * @param {boolean} force
 * @param {{ quiet?: boolean }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   outcome?: "restored" | "stripped" | "none",
 *   error?: { harnessId: string, label: string, message: string },
 * }>}
 */
async function restoreHarness(ctx, home, harnessId, force, { quiet = false } = {}) {
  const adapter = getHarness(harnessId);
  const offCtx = {
    ...ctx,
    home,
    settingsPath: "",
    configPath: "",
    dataDir: "",
    force,
    quiet,
  };
  try {
    const outcome = await adapter.off(offCtx);
    return { ok: true, outcome };
  } catch (error) {
    return {
      ok: false,
      error: { harnessId, label: adapter.label, message: error.message },
    };
  }
}

/**
 * Top-level paths an install owns: the CLI checkout, the launchers, and the
 * data directory, plus a pre-rename ~/.fireconnect an unfinished move left
 * behind. The whole data directory comes last so
 * nothing is left behind (update-check.json, key-storage.json, plaintext
 * .api-key fallback), and after the launchers so a failure removing it doesn't
 * skip them. (gh fw-ai/nexus-cli#12)
 * @param {string} home
 */
async function installFootprint(home) {
  return [
    path.join(home, DATA_DIRNAME, "cli"),
    ...await ownedLaunchers(home),
    path.join(home, DATA_DIRNAME),
    path.join(home, LEGACY_DATA_DIRNAME),
    path.join(home, LEGACY_ASIDE_DIRNAME),
  ];
}

/**
 * Shared tail: remove the shell env hook, stored secret, and the remaining
 * top-level Nexus files (config, CLI launcher, launcher symlink, the
 * final `~/.nexus` sweep). Per-harness data dirs are deleted earlier in
 * the interactive path; in the non-interactive path they're included here.
 *
 * @param {string} home
 * @param {boolean} removeCatalog
 * @param {{
 *   skipPerHarnessDirs?: Set<string>,
 *   reportStep?: (label: string) => Promise<void> | void,
 * }} [opts]  `skipPerHarnessDirs`: harness dirs already removed by the
 *   interactive path (the non-interactive path removes all). Interactive runs
 *   only reach this function when every restore succeeded, so the skip set holds
 *   the harnesses that were on; the unskipped entries clean up dirs left behind
 *   by harnesses that were already off. `reportStep`: called after each
 *   cleanup step so the interactive path can tick a checklist.
 * @returns {Promise<{ path: string, message: string }[]>} removal failures
 */
async function removeFireConnectFiles(home, removeCatalog, { skipPerHarnessDirs, reportStep } = {}) {
  await removeShellEnvHook(home).catch(() => {});
  await reportStep?.("Shell environment hook");

  await deleteSecret(home);
  await reportStep?.("Stored API key");

  const perHarnessDirs = Object.values(HARNESS_DATA_DIR)
    .filter((dir) => !skipPerHarnessDirs?.has(dir));

  const pathsToRemove = [
    ...perHarnessDirs.map((dir) => path.join(home, dir)),
    ...(removeCatalog ? [path.join(home, CODEX_CATALOG_RELATIVE_PATH)] : []),
    globalConfigPath(home),
    ...await installFootprint(home),
  ];

  const removalFailures = [];
  for (const pathToRemove of pathsToRemove) {
    const failure = await removePath(pathToRemove);
    if (failure) {
      removalFailures.push(failure);
    }
  }
  await reportStep?.("Nexus CLI files");
  return removalFailures;
}

/**
 * Uninstall is mostly instant, which makes the checklist flash past in one
 * frame — the user can't tell what was restored. A short beat between steps
 * makes it legible. Interactive runs only; skipped under NEXUS_TEST so
 * suites don't pay for it.
 * @param {boolean} interactive
 * @param {number} [ms]
 */
async function pace(interactive, ms = 220) {
  if (!interactive || process.env.NEXUS_TEST === "1") {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reported when a harness could not be restored, so uninstall stopped before
 * removing Nexus. Harnesses restored earlier in the run stay restored —
 * that is the desired end state for them — so the message says so rather than
 * claiming nothing happened.
 * @param {{ harnessId: string, label: string, message: string }[]} offErrors
 * @param {string[]} restoredLabels  harnesses already restored in this run
 */
function printUninstallAborted(offErrors, restoredLabels) {
  console.log("");
  console.log("  Stopped before removing Nexus CLI.");
  console.log("");
  for (const { label, message } of offErrors) {
    console.log(`  ${label} could not be restored:`);
    console.log(`    ${message}`);
  }
  if (restoredLabels.length > 0) {
    console.log("");
    console.log(`  Already restored, and left that way: ${restoredLabels.join(", ")}.`);
  }
  console.log("");
  console.log("  Nexus CLI is still installed and your backups are intact, so it");
  console.log("  is safe to resolve the above and run the same command again:");
  console.log(`    ${accent(`${CLI_NAME} uninstall`)}`);
  console.log("");
  console.log("  To remove Nexus CLI regardless, without waiting on an editor");
  console.log("  (a running editor may overwrite the restore):");
  console.log(`    ${accent(`${CLI_NAME} uninstall --force`)}`);
  console.log("");
}

/**
 * Parting message after a clean uninstall. Nexus edits the user's tools,
 * so the important line is "your originals are back" — the send-off is warm
 * but the actionable facts (restart, how to come back) come first.
 * @param {string[]} restoredLabels
 */
function printFarewell(restoredLabels) {
  console.log("");
  if (restoredLabels.length > 0) {
    console.log(`  Your original settings are back in ${restoredLabels.join(", ")}.`);
    console.log("  Restart anything still open to pick them up.");
  } else {
    console.log("  No harness settings were touched, so there is nothing to restore.");
  }
  console.log("");
  console.log("  Sad to see you go! If something pushed you away, we'd like to know:");
  console.log(`    ${accent("https://github.com/fw-ai/nexus-cli/issues")}`);
  console.log("");
  console.log("  Reinstall anytime:");
  console.log(`    ${accent("curl -fsSL https://nexus.fireworks.ai/install.sh | bash")}`);
  console.log("");
}

/**
 * Print the final uninstall summary.
 * @param {{ offErrors: { harnessId: string, label: string, message: string }[], removalFailures: { path: string, message: string }[] }} state
 */
function printUninstallSummary({ offErrors, removalFailures }) {
  const hasErrors = offErrors.length > 0 || removalFailures.length > 0;
  if (!hasErrors) {
    console.log("Nexus CLI has been uninstalled. Restart any running harnesses (Claude Code, OpenCode, Codex, Pi, Cursor, VS Code, Copilot, DeepSeek Harness) to fully apply.");
    return;
  }
  for (const { harnessId, label, message } of offErrors) {
    console.error(`Warning: failed to restore ${harnessId}: ${message}`);
    console.error(`Restart ${label} manually to clear any Fireworks settings.`);
  }
  if (removalFailures.length > 0) {
    console.error("Nexus CLI uninstall completed with file removal errors:");
    for (const { path: failedPath, message } of removalFailures) {
      console.error(`  ${failedPath}: ${message}`);
    }
  } else {
    console.log("Nexus CLI files removed. Restart any running harnesses to fully apply.");
  }
  process.exitCode = 1;
}

/**
 * Uninstall Nexus: restore each enabled harness's pre-Nexus
 * config, then remove Nexus's own files.
 *
 * Interactive (TTY, no --force): restore harnesses one by one as a checklist.
 * Cursor/VS Code get the interactive "quit the IDE" wait (their `prepareOff`
 * calls `ensureCursorStopped`/`ensureVscodeStopped`); file-based harnesses
 * restore immediately. Each harness's data dir is deleted right after its
 * `off` succeeds, so a later failure never leaves restore unrecoverable.
 *
 * Non-interactive (no TTY, or --force): force-restore every harness without
 * waiting (CI/scripts), then batch-remove all files — the historical behavior.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runUninstallCommand(ctx) {
  const home = process.env.HOME ?? "";
  if (!home) {
    throw new Error("HOME is not set; uninstall requires HOME to be set.");
  }
  if (ctx.home && ctx.home !== home) {
    throw new Error("uninstall does not support --home");
  }
  if (ctx.settingsPath || ctx.configPath || ctx.dataDir) {
    throw new Error("uninstall does not support path overrides");
  }

  // Only harnesses that are actually on: one never routed has nothing to restore.
  const harnessIds = await listRoutedHarnessIds(ctx, home);
  // Interactive only when stdin is a TTY and the user didn't pass --force.
  // This mirrors `ensureIdeStopped`'s own TTY gate, so the two stay consistent:
  // a non-TTY (CI/pipe) keeps the historical force-restore-all behavior.
  const interactive = Boolean(process.stdin.isTTY) && !ctx.force;

  const offErrors = [];
  const removedHarnessDirs = new Set();

  const restoredLabels = [];

  if (interactive) {
    if (harnessIds.length === 0) {
      // No harness is on, but Nexus itself may still be
      // installed (CLI launcher, ~/.nexus, stored key). Don't bail —
      // fall through to file removal. Only say "not installed" when there
      // are no harnesses AND no Nexus files on disk.
      if (!(await installFootprint(home)).some((file) => existsSync(file))) {
        console.log("Nexus CLI is not installed.");
        return;
      }
    }

    console.log("");
    console.log(`  Uninstalling ${accent("Nexus CLI")}`);

    if (harnessIds.length > 0) {
      console.log("");
      console.log("  Restoring your harnesses");
      // Pad labels so the ✓ column lines up regardless of name length.
      const width = Math.max(...harnessIds.map((id) => getHarness(id).label.length));

      for (const harnessId of harnessIds) {
        const adapter = getHarness(harnessId);
        const label = adapter.label.padEnd(width);
        // No spinner here. `off` narrates on stdout itself (and Cursor/VS Code
        // may print an interactive "quit the IDE" prompt), and a spinner
        // rewriting the current line collides with both. `quiet` silences the
        // harness's own restored/restart lines so this checklist is the single
        // source of narration; the prompt, which the user must see, still prints.
        const result = await restoreHarness(ctx, home, harnessId, false, { quiet: true });

        if (result.ok) {
          const touched = result.outcome === "restored" || result.outcome === "stripped";
          console.log(`    ${checkGlyph()} ${label}  ${touched ? "restored" : "wasn't connected"}`);
          if (touched) {
            restoredLabels.push(adapter.label);
          }
          // Delete this harness's data dir now that restore is confirmed, so
          // the backup only goes away once `off` has succeeded.
          const dir = HARNESS_DATA_DIR[harnessId];
          if (dir) {
            await removePath(path.join(home, dir));
            removedHarnessDirs.add(dir);
          }
        } else {
          offErrors.push(result.error);
          // Data dir deliberately kept — see the abort below, which stops
          // before any destructive cleanup so this backup stays usable.
          console.log(`    ${red(symbols.fail)} ${label}  could not be restored — ${result.error.message}`);
        }
        await pace(interactive);
      }
    }
  } else {
    // Non-interactive: force-restore every harness without waiting.
    for (const harnessId of harnessIds) {
      const result = await restoreHarness(ctx, home, harnessId, true);
      if (!result.ok) {
        offErrors.push(result.error);
        console.error(`Warning: failed to restore ${harnessId}: ${result.error.message}`);
        console.error(`Restart ${result.error.label} manually to clear any Fireworks settings.`);
      }
    }
  }

  // A harness that failed to restore is still routed through Fireworks, and its
  // backup under ~/.nexus/<id> is the only way back. Stop before any
  // destructive cleanup so that backup — plus the config and the CLI needed to
  // use it — survives for a retry. The most likely trigger is the user
  // declining to quit Cursor; deleting their backup in response to "no" would
  // be indefensible.
  //
  // Non-interactive runs keep the historical delete-everything behavior: they
  // force past the IDE guard (so this rarely trips) and a script cannot act on
  // a retry hint, whereas leaving a half-removed install would strand CI.
  if (interactive && offErrors.length > 0) {
    printUninstallAborted(offErrors, restoredLabels);
    process.exitCode = 1;
    return;
  }

  // Codex catalog: keep it if codex `off` failed, or if the restored config
  // still references the Fireworks catalog (otherwise `codex off` would 404).
  const codexOffFailed = offErrors.some((error) => error.harnessId === HARNESS.CODEX);
  let removeCatalog = !codexOffFailed;
  if (removeCatalog) {
    try {
      const raw = await readFile(codexConfigPath(home), "utf8");
      if (snapshotReferencesFireworksCatalog(raw)) {
        removeCatalog = false;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (interactive) {
    console.log("");
    console.log("  Cleaning up");
  }

  const cleanupWidth = "Shell environment hook".length;
  const removalFailures = await removeFireConnectFiles(home, removeCatalog, {
    skipPerHarnessDirs: interactive ? removedHarnessDirs : undefined,
    reportStep: interactive
      ? async (label) => {
        console.log(`    ${checkGlyph()} ${label.padEnd(cleanupWidth)}  removed`);
        await pace(interactive, 160);
      }
      : undefined,
  });

  if (interactive && removalFailures.length === 0 && offErrors.length === 0) {
    printFarewell(restoredLabels);
    return;
  }

  printUninstallSummary({ offErrors, removalFailures });
}

/**
 * @param {import("../parse-args.mjs").parseCli extends Function ? ReturnType<import("../parse-args.mjs").parseCli> : never} parsed
 */
export async function runGlobalCommand(parsed) {
  const { command, ctx } = parsed;

  if (command === "help") {
    printHelp(parsed.helpTopic ?? "");
    return;
  }

  if (command === "launcher") {
    const { runLauncherCommand } = await import("./launcher.mjs");
    await runLauncherCommand(ctx);
    return;
  }

  if (command === "login" || command === "logout") {
    const { runLoginCommand, runLogoutCommand } = await import("./login.mjs");
    await (command === "login" ? runLoginCommand(ctx) : runLogoutCommand(ctx));
    return;
  }

  if (command === "status") {
    const { runStatusCommand } = await import("./status.mjs");
    await runStatusCommand(ctx);
    return;
  }

  if (command === "harnesses") {
    await runHarnessesCommand(ctx);
    return;
  }

  if (command === "model" && parsed.modelSubcommand === "list") {
    await runGlobalModelListCommand(ctx);
    return;
  }

  if (command === "configure") {
    await runConfigureCommand(ctx);
    return;
  }

  if (command === "auto") {
    await runAutoCommand(ctx);
    return;
  }

  if (command === "key") {
    const { runKeyCommand } = await import("./key.mjs");
    await runKeyCommand(ctx, parsed.keySubcommand);
    return;
  }

  if (command === "update") {
    await runUpgradeCommand();
    return;
  }

  if (command === "banner") {
    runBannerCommand();
    return;
  }

  if (command === "finalize-install") {
    await runFinalizeInstallCommand(ctx);
    return;
  }

  if (command === "version") {
    runVersionCommand(ctx);
    return;
  }

  if (command === "uninstall") {
    await runUninstallCommand(ctx);
    return;
  }

  throw new Error(`Unknown global command: ${command}`);
}
