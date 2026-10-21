import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

import { desktopDataDir } from "./lineup.mjs";

const runExec = promisify(execFile);

/** Agent/label for the profile-lane shim service (launchd label / systemd unit stem). */
export const SHIM_AGENT_LABEL = "ai.fireworks.nexus.claude-desktop-shim";
/** Pre-rename label. A job still loaded under it holds the shim's port. */
export const LEGACY_SHIM_AGENT_LABEL = "ai.fireworks.fireconnect.claude-desktop-shim";
const LAUNCHCTL = "/bin/launchctl";
const SYSTEMCTL = "systemctl";
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Platforms the shim service can be installed on. */
export const SUPPORTED_PLATFORMS = ["darwin", "linux"];

/**
 * Every privileged/system-mutating helper is gated on BOTH an explicit opt-in
 * from the calling command AND the NEXUS_TEST kill switch. Tests never
 * pass a real `allowSystemChanges: true` with the default runner.
 */
function systemChangesAllowed({ allowSystemChanges = false } = {}) {
  if (process.env.NEXUS_TEST === "1") {
    throw new Error("NEXUS_TEST=1: Desktop system changes (services) are disabled.");
  }
  if (!allowSystemChanges) {
    throw new Error("Desktop system changes require explicit opt-in.");
  }
}

/**
 * TLS trust for the shim's upstream calls. launchd and the systemd user
 * manager start it with a bare environment, so behind a TLS-inspecting proxy
 * (Zscaler and the like) its fetch would reject the corporate root. Trust the
 * system store (macOS keychain, Linux CA bundle) when this Node supports it
 * (22.15+/23.8+; an unknown flag would make node exit), and carry over an
 * explicit NODE_EXTRA_CA_CERTS bundle.
 */
export function shimTrustOptions(env = process.env, allowedFlags = process.allowedNodeEnvironmentFlags) {
  return {
    nodeArgs: allowedFlags.has("--use-system-ca") ? ["--use-system-ca"] : [],
    env: env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS } : {},
  };
}

/**
 * Where the owned service definition lives:
 * - macOS: ~/Library/LaunchAgents/<label>.plist
 * - Linux: <config dir>/systemd/user/<label>.service, the config dir chosen
 *   like Desktop's own ($XDG_CONFIG_HOME for the real home, else ~/.config)
 * @param {string} home
 * @param {{ platform?: string, label?: string, env?: NodeJS.ProcessEnv, realHome?: string }} [options]
 */
export function shimServiceFilePath(home, {
  platform = process.platform, label = SHIM_AGENT_LABEL, env = process.env, realHome = os.homedir(),
} = {}) {
  if (platform === "linux") {
    return path.join(desktopDataDir(home, "systemd", { platform, env, realHome }), "user", `${label}.service`);
  }
  return launchAgentPlistPath(home, label);
}

/**
 * Pure launchd plist builder (no side effects; heavily unit-tested).
 * @param {{ nodeExec: string, nodeArgs?: string[], entry: string, home: string, env?: Record<string, string>, logPath: string, errorPath: string, label?: string }} args
 */
export function buildLaunchAgentPlist({ nodeExec, nodeArgs = [], entry, home, env = {}, logPath, errorPath, label = SHIM_AGENT_LABEL }) {
  const escape = (value) => String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const args = [nodeExec, ...nodeArgs, entry, "--home", home]
    .map((arg) => `    <string>${escape(arg)}</string>`).join("\n");
  const vars = Object.entries({ ...env, HOME: home })
    .map(([name, value]) => `    <key>${escape(name)}</key><string>${escape(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>StandardOutPath</key><string>${escape(logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(errorPath)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

/**
 * Quote one word for a systemd unit `ExecStart=` / `Environment=` line:
 * double quotes with backslash-escaped `\\` and `"` (systemd.service(5),
 * "Command lines"). Always quoted so spaces and `%` specifiers in paths
 * are literal.
 */
function unitQuote(value) {
  const escaped = unitSpecifierSafe(String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"'));
  return `"${escaped}"`;
}

/** `%` starts a systemd specifier everywhere in a unit file; double it to keep it literal. */
function unitSpecifierSafe(value) {
  return String(value).replaceAll("%", "%%");
}

/**
 * Pure systemd user-unit builder (the Linux counterpart of the plist).
 * Restart=always mirrors KeepAlive; the unit is enabled under default.target
 * so it comes up at login. XDG_CONFIG_HOME is baked in under the same rule
 * thirdPartyDir applies (set, absolute, and `home` is the real home): the
 * user manager's environment need not carry it, and the shim must find the
 * same Claude-3p directory `on` wrote.
 * @param {{ nodeExec: string, nodeArgs?: string[], entry: string, home: string, env?: Record<string, string>, logPath: string, errorPath: string, processEnv?: NodeJS.ProcessEnv, realHome?: string }} args
 */
export function buildSystemdUnit({
  nodeExec, nodeArgs = [], entry, home, env = {}, logPath, errorPath,
  processEnv = process.env, realHome = os.homedir(),
}) {
  const xdg = processEnv.XDG_CONFIG_HOME;
  const vars = { ...env, HOME: home };
  if (xdg && path.isAbsolute(xdg) && path.resolve(home) === path.resolve(realHome)) {
    vars.XDG_CONFIG_HOME = xdg;
  }
  const environment = Object.entries(vars).map(([name, value]) => `Environment=${unitQuote(`${name}=${value}`)}`);
  const exec = [nodeExec, ...nodeArgs, entry, "--home", home].map(unitQuote).join(" ");
  return `[Unit]
Description=Nexus Claude Desktop shim (Fireworks gateway on 127.0.0.1)
# Owned by nexus: \`nexus claude-desktop off\` removes it.

[Service]
Type=simple
ExecStart=${exec}
${environment.join("\n")}
Restart=always
RestartSec=2
StandardOutput=append:${unitSpecifierSafe(logPath)}
StandardError=append:${unitSpecifierSafe(errorPath)}

[Install]
WantedBy=default.target
`;
}

/**
 * Start the owned LaunchAgent (bootstrap under the invoking user's GUI
 * domain). Never kills or labels anything it does not own.
 * @param {string} plistPath
 * @param {{ run?: typeof runExec, allowSystemChanges?: boolean, label?: string }} [options]
 */
export async function startLaunchAgent(plistPath, options = {}) {
  const label = options.label ?? SHIM_AGENT_LABEL;
  systemChangesAllowed(options);
  const run = options.run ?? runExec;
  const uid = process.getuid();
  await run(LAUNCHCTL, ["bootstrap", `gui/${uid}`, plistPath], {
    timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  }).catch(async (error) => {
    // "Bootstrapped already" (5: Input/output error) means an owned agent is
    // loaded from a previous `on` — with the plist as it was THEN. bootstrap
    // never reloads a loaded job, so boot it out and load the current plist;
    // otherwise a config change on upgrade silently never takes effect.
    const message = String(error?.stderr ?? error?.message ?? "");
    if (!/already bootstrapped|5:/i.test(message)) throw error;
    await run(LAUNCHCTL, ["bootout", `gui/${uid}/${label}`], {
      timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    }).catch(() => {});
    await run(LAUNCHCTL, ["bootstrap", `gui/${uid}`, plistPath], {
      timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    });
  });
  await run(LAUNCHCTL, ["kickstart", `-k`, `gui/${uid}/${label}`], {
    timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  }).catch(() => {});
}

/**
 * Stop and unload the owned LaunchAgent.
 * @param {{ run?: typeof runExec, allowSystemChanges?: boolean, label?: string }} [options]
 */
export async function stopLaunchAgent(options = {}) {
  const label = options.label ?? SHIM_AGENT_LABEL;
  systemChangesAllowed(options);
  const run = options.run ?? runExec;
  const uid = process.getuid();
  await run(LAUNCHCTL, ["bootout", `gui/${uid}/${label}`], {
    timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  }).catch((error) => {
    const message = String(error?.stderr ?? error?.message ?? "");
    if (/No such process|not loaded|Could not find/i.test(message)) return;
    throw error;
  });
}

function systemctlUser(run, args) {
  return run(SYSTEMCTL, ["--user", ...args], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
}

/** True for the errors a `systemctl --user` call makes when there is no user manager to talk to. */
function noUserManager(error) {
  const message = String(error?.stderr ?? error?.message ?? "");
  return /Failed to connect to bus|not been booted with systemd|\$XDG_RUNTIME_DIR|No medium found/i.test(message)
    || error?.code === "ENOENT";
}

/**
 * Start the owned systemd user unit. The unit file is already written at
 * `unitPath`; daemon-reload picks up a changed definition (upgrade), enable
 * makes it come back at login (and links it in when it is outside the search
 * path), and restart (not `enable --now`, which leaves
 * a running service on its old definition) applies the current one. Only
 * ever addresses our own unit name.
 * @param {string} unitPath
 * @param {{ run?: typeof runExec, allowSystemChanges?: boolean, label?: string }} [options]
 */
export async function startSystemdUnit(unitPath, options = {}) {
  const label = options.label ?? SHIM_AGENT_LABEL;
  const unit = `${label}.service`;
  systemChangesAllowed(options);
  const run = options.run ?? runExec;
  try {
    await systemctlUser(run, ["daemon-reload"]);
  } catch (error) {
    if (!noUserManager(error)) throw error;
    throw new Error(
      "No systemd user session is available (systemctl --user cannot reach the user manager). "
      + "Run this from a logged-in desktop session, or check `loginctl user-status`.",
      { cause: error },
    );
  }
  // By path: a unit outside the manager's search path (a --home sandbox, or
  // a manager started without the shell's XDG_CONFIG_HOME) is linked in.
  await systemctlUser(run, ["enable", unitPath]);
  await systemctlUser(run, ["restart", unit]);
}

/**
 * Stop and disable the owned systemd user unit, remove its file, and
 * reload so the manager forgets it. A unit that was never loaded is success.
 * @param {{ run?: typeof runExec, allowSystemChanges?: boolean, label?: string, unitPath?: string }} [options]
 */
export async function stopSystemdUnit(options = {}) {
  const label = options.label ?? SHIM_AGENT_LABEL;
  const unit = `${label}.service`;
  systemChangesAllowed(options);
  const run = options.run ?? runExec;
  const ignorable = (error) => {
    const message = String(error?.stderr ?? error?.message ?? "");
    if (/not loaded|does not exist|No such file|not found|Unit .* is not loaded/i.test(message)) return;
    if (noUserManager(error)) return; // nothing is running without a manager
    throw error;
  };
  await systemctlUser(run, ["disable", "--now", unit]).catch(ignorable);
  await systemctlUser(run, ["reset-failed", unit]).catch(() => {});
  if (options.unitPath) await rm(options.unitPath, { force: true });
  await systemctlUser(run, ["daemon-reload"]).catch(() => {});
}

/**
 * Platform dispatchers: the profile lane calls these and never branches on
 * the OS itself.
 */
export function buildShimServiceFile(args, { platform = process.platform } = {}) {
  return platform === "linux" ? buildSystemdUnit(args) : buildLaunchAgentPlist(args);
}

export async function startShimService(servicePath, options = {}) {
  const platform = options.platform ?? process.platform;
  return platform === "linux"
    ? startSystemdUnit(servicePath, options)
    : startLaunchAgent(servicePath, options);
}

export async function stopShimService(options = {}) {
  const platform = options.platform ?? process.platform;
  return platform === "linux"
    ? stopSystemdUnit(options)
    : stopLaunchAgent(options);
}

/**
 * @param {string} home
 * @param {string} label
 */
export function launchAgentPlistPath(home, label) {
  return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * Unload and delete a shim job left under the pre-rename label, so it cannot
 * keep the port while the current job starts.
 * @param {string} home
 * @param {{ run?: typeof runExec, allowSystemChanges?: boolean, platform?: string }} [options]
 */
export async function retireLegacyShimAgent(home, options = {}) {
  // Only launchd ever ran a pre-rename shim; Linux support shipped as Nexus.
  if ((options.platform ?? process.platform) !== "darwin") return;
  await stopLaunchAgent({ ...options, label: LEGACY_SHIM_AGENT_LABEL });
  await rm(launchAgentPlistPath(home, LEGACY_SHIM_AGENT_LABEL), { force: true });
}
