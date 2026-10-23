import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { HARNESS } from "./id.mjs";
import { appUserDataDir } from "../io/user-data-dir.mjs";
import { desktopDataDir } from "../harnesses/claude-desktop/lineup.mjs";
import { vscodeInstallCandidates } from "../harnesses/vscode/install.mjs";

/**
 * @typedef {{ env?: NodeJS.ProcessEnv, platform?: string, root?: string, loginPath?: string }} DetectOptions
 * `root` prefixes the machine-wide install locations (/Applications, /opt,
 * /usr, /snap, /var/lib/flatpak) so specs never see the host's own installs.
 * `loginPath` is an extra `PATH` to search for commands, such as the one a
 * login shell sets up (see `detectInstalledHarnessesAsync`).
 *
 * @typedef {{
 *   hint: string,
 *   commands: string[],
 *   paths: string[],
 *   entries: { dir: string, pattern: RegExp }[],
 * }} InstallSpec
 *
 * @typedef {"installed" | "missing" | "unknown"} InstallState
 */

/**
 * The first executable named `name` in `dirs` (trying each `PATHEXT`
 * extension on Windows), or "".
 *
 * @param {string[]} dirs
 * @param {string} name
 * @param {DetectOptions} [options]
 */
function findCommandIn(dirs, name, { env = process.env, platform = process.platform } = {}) {
  const exts = platform === "win32"
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here; keep looking
      }
    }
  }
  return "";
}

/** Split a `PATH` value the way `platform` does. */
function splitPath(value, platform) {
  return String(value ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
}

/**
 * Whether `name` resolves to an executable on `PATH` (with `PATHEXT` on
 * Windows), the way a shell would find it.
 *
 * @param {string} name
 * @param {DetectOptions} [options]
 */
export function findCommand(name, options = {}) {
  const { env = process.env, platform = process.platform } = options;
  return findCommandIn(splitPath(env.PATH ?? env.Path, platform), name, { env, platform });
}

/**
 * Where installers put commands that may be missing from this process's
 * `PATH`, such as when a GUI app launches Nexus with a minimal environment:
 * npm, Volta, and Bun globals, the native installers' ~/.local/bin, Homebrew,
 * and the system bin dirs. On Windows, npm's global bin under %APPDATA%.
 *
 * @param {string} home
 * @param {DetectOptions} [options]
 */
export function commandFallbackDirs(home, { env = process.env, platform = process.platform, root = "/" } = {}) {
  if (platform === "win32") {
    return [path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "npm")];
  }
  const sys = (...parts) => path.join(root, ...parts);
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    sys("opt", "homebrew", "bin"),
    sys("usr", "local", "bin"),
    sys("usr", "bin"),
  ];
}

/**
 * Whether `candidate` is a footprint of an install: a file, or a folder with
 * at least one entry. An empty folder doesn't count, since config folders are
 * often created (by Nexus's `on`, or by other tools) before anything is
 * installed.
 *
 * @param {string} candidate
 */
export function hasFootprint(candidate) {
  try {
    const stats = statSync(candidate);
    if (stats.isFile()) return true;
    return stats.isDirectory() && readdirSync(candidate).length > 0;
  } catch {
    return false;
  }
}

/** Whether `dir` has an entry whose name matches `pattern`. */
function hasEntryMatching(dir, pattern) {
  try {
    return readdirSync(dir).some((name) => pattern.test(name));
  } catch {
    return false;
  }
}

/**
 * What counts as installed for each harness on `platform`. Any one signal is
 * enough, and the list leans permissive: allowing `on` for a missing tool
 * leaves a config `off` undoes, while refusing a real install blocks the user.
 * - a command on `PATH`, or in a dir installers commonly use
 *   (`commandFallbackDirs`)
 * - an app or binary at a known install location
 * - data only the tool itself writes (session history, its own logs), so an
 *   install off `PATH` or used only inside an editor still counts. Nexus
 *   never writes these, unlike the config folders it creates; a spec runs
 *   every harness's `on` to keep it that way.
 * - a matching entry in a known dir: AppImages, editor extensions, Store apps
 * A path counts only as a file or a non-empty folder (`hasFootprint`).
 * `null` means there's no reliable signal on this platform: `on` is never
 * refused there, and the launcher doesn't claim it's detected.
 *
 * @param {string} home
 * @param {DetectOptions} [options]
 * @returns {Record<string, InstallSpec | null>}
 */
export function harnessInstallSpecs(home, { env = process.env, platform = process.platform, root = "/" } = {}) {
  const darwin = platform === "darwin";
  const linux = platform === "linux";
  const win = platform === "win32";
  const sys = (...parts) => path.join(root, ...parts);
  const exe = win ? ".exe" : "";
  const apps = (...names) => (darwin
    ? [sys("Applications"), path.join(home, "Applications")].flatMap((dir) => names.map((name) => path.join(dir, `${name}.app`)))
    : []);
  const localAppData = win ? (env.LOCALAPPDATA || path.join(home, "AppData", "Local")) : "";
  // Where Linux users keep AppImages, which have no fixed install path.
  const appImageDirs = linux
    ? [path.join(home, "Applications"), path.join(home, ".local", "bin"), path.join(home, "AppImages"), sys("opt")]
    : [];
  const appImages = (pattern) => appImageDirs.map((dir) => ({ dir, pattern }));
  const flatpak = (id) => (linux
    ? [sys("var", "lib", "flatpak", "app", id), path.join(home, ".local", "share", "flatpak", "app", id)]
    : []);
  // Electron apps keep their own `logs` dir in the same user-data folder the
  // harness writes to, so both resolve it through one helper.
  const appLogs = (name) => path.join(appUserDataDir(home, name, { platform, env }), "logs");
  // Extensions for VS Code and its forks, for tools used only inside an editor.
  const extensionDirs = [".vscode", ".vscode-insiders", ".cursor", ".windsurf"].map((dir) => path.join(home, dir, "extensions"));
  const extensions = (pattern) => extensionDirs.map((dir) => ({ dir, pattern }));
  // The same overrides the harnesses honor when they write their config.
  const copilotHome = env.COPILOT_HOME?.trim() ? path.resolve(env.COPILOT_HOME.trim()) : path.join(home, ".copilot");
  const dshHome = env.DSH_HOME?.trim() || path.join(home, ".dsh");
  /** @returns {InstallSpec} */
  const spec = (hint, commands, paths = [], entries = []) => ({ hint, commands, paths, entries });

  return {
    // Native installer: ~/.local/bin/claude (claude.exe on Windows). Session
    // transcripts land in ~/.claude/projects, also for the editor extension.
    [HARNESS.CLAUDE]: spec(
      "the `claude` command, Claude Code's session history, or its editor extension",
      ["claude"],
      [
        path.join(home, ".local", "bin", `claude${exe}`),
        path.join(home, ".claude", "local", `claude${exe}`),
        path.join(home, ".claude", "projects"),
      ],
      extensions(/^anthropic\.claude-code-/i),
    ),
    // Desktop's harness runs on macOS and Linux only (`on` refuses Windows).
    [HARNESS.CLAUDE_DESKTOP]: darwin
      ? spec("Claude.app", [], [...apps("Claude"), path.join(home, "Library", "Logs", "Claude")])
      : linux
        ? spec("the `claude-desktop` command", ["claude-desktop"], [path.join(desktopDataDir(home, "Claude", { platform, env }), "logs")])
        : null,
    // OpenCode keeps sessions under ~/.local/share/opencode on every platform.
    [HARNESS.OPENCODE]: spec("the `opencode` command or OpenCode's session data", ["opencode"], [
      path.join(home, ".opencode", "bin", `opencode${exe}`),
      path.join(home, ".local", "share", "opencode"),
    ]),
    // `nexus codex` also routes the ChatGPT and Codex desktop apps, so either
    // one counts without the CLI. On Windows the desktop app is the
    // `OpenAI.Codex` Store package, and the CLI's own installer uses
    // %LOCALAPPDATA%\Programs\OpenAI\Codex\bin. On Linux the app is a
    // `chatgpt` command, an AppImage, or a dir under /opt.
    [HARNESS.CODEX]: spec(
      "the `codex` command, the ChatGPT or Codex app, Codex's session history, or its editor extension",
      ["codex", ...(linux ? ["chatgpt"] : [])],
      [
        ...apps("ChatGPT", "Codex"),
        ...(win ? [path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe")] : []),
        path.join(home, ".codex", "sessions"),
      ],
      [
        ...(win
          ? [{ dir: path.join(localAppData, "Packages"), pattern: /^OpenAI\.Codex_/i }]
          : [...appImages(/^(chatgpt|codex).*\.appimage$/i), ...(linux ? [{ dir: sys("opt"), pattern: /^(chatgpt|codex)$/i }] : [])]),
        // The Codex editor extension.
        ...extensions(/^openai\.chatgpt-/i),
      ],
    ),
    [HARNESS.PI]: spec("the `pi` command or Pi's session history", ["pi"], [path.join(home, ".pi", "agent", "sessions")]),
    [HARNESS.CURSOR]: spec(
      "the `cursor` command, the Cursor app, or Cursor's own logs",
      ["cursor"],
      [
        ...apps("Cursor"),
        ...(win ? [path.join(localAppData, "Programs", "cursor")] : []),
        ...(linux ? [sys("usr", "share", "cursor", "cursor"), sys("opt", "cursor", "cursor"), sys("opt", "Cursor", "cursor")] : []),
        appLogs("Cursor"),
      ],
      appImages(/^cursor.*\.appimage$/i),
    ),
    // The machine-wide installs vscode/install.mjs already knows, plus the
    // shell command, the Windows per-user installer, snap, and flatpak.
    [HARNESS.VSCODE]: spec(
      "the `code` command, the VS Code app, or VS Code's own logs",
      ["code", "code-insiders"],
      [
        ...vscodeInstallCandidates({ platform, env, home, root }).map((candidate) => candidate.productJson),
        // Also catches a copy dragged into ~/Applications.
        ...apps("Visual Studio Code", "Visual Studio Code - Insiders"),
        ...(win ? [
          path.join(localAppData, "Programs", "Microsoft VS Code"),
          path.join(localAppData, "Programs", "Microsoft VS Code Insiders"),
        ] : []),
        ...(linux ? [sys("snap", "code"), sys("snap", "code-insiders"), ...flatpak("com.visualstudio.code")] : []),
        appLogs("Code"),
        appLogs("Code - Insiders"),
      ],
    ),
    // The app's data.db can't count: Nexus creates it on a never-launched
    // install. Linux: the official .deb installs `github`, AppImage wrappers
    // use `github-copilot`. The Windows setup.exe documents no install path,
    // so Windows has no reliable signal.
    [HARNESS.COPILOT_APP]: darwin
      ? spec("GitHub Copilot.app", [], apps("GitHub Copilot"))
      : linux
        ? spec(
          "the `github` or `github-copilot` command, or a GitHub Copilot AppImage",
          ["github", "github-copilot"],
          [],
          appImages(/^github[-_ ]?copilot.*\.appimage$/i),
        )
        : null,
    // The CLI's own session history (older releases used history-session-state).
    // Not providers.json: that's the file `on` writes.
    [HARNESS.COPILOT_CLI]: spec("the `copilot` command or the Copilot CLI's session history", ["copilot"], [
      path.join(copilotHome, "session-state"),
      path.join(copilotHome, "history-session-state"),
    ]),
    // dsh creates a profile under $DSH_HOME/profiles on first run. Nexus only
    // patches profiles that already exist, and $DSH_HOME itself doesn't count:
    // `on` creates it for settings.yaml.
    [HARNESS.DEEPSEEK]: spec("the `dsh` command or DeepSeek Harness's profiles", ["dsh"], [path.join(dshHome, "profiles")]),
  };
}

/**
 * Check whether `harnessId` is installed on this machine, and say what was
 * looked for. Config folders don't count, since Nexus itself creates them,
 * and neither do empty folders.
 * `unknown` means the platform has no reliable signal for this harness.
 *
 * @param {string} home
 * @param {string} harnessId
 * @param {DetectOptions} [options]
 * @returns {{ state: InstallState, hint: string }}
 */
export function checkHarnessInstall(home, harnessId, options = {}) {
  const spec = harnessInstallSpecs(home, options)[harnessId];
  if (!spec) {
    return { state: "unknown", hint: "" };
  }
  const { env = process.env, platform = process.platform } = options;
  const commandDirs = [
    ...splitPath(env.PATH ?? env.Path, platform),
    ...splitPath(options.loginPath, platform),
    ...commandFallbackDirs(home, options),
  ];
  const found = spec.commands.some((name) => findCommandIn(commandDirs, name, { env, platform }))
    || spec.paths.some(hasFootprint)
    || spec.entries.some(({ dir, pattern }) => hasEntryMatching(dir, pattern));
  return { state: found ? "installed" : "missing", hint: spec.hint };
}

/**
 * Whether `on` may run for `harnessId`: anything but a confirmed miss.
 *
 * @param {string} home
 * @param {string} harnessId
 * @param {DetectOptions} [options]
 */
export function isHarnessInstalled(home, harnessId, options = {}) {
  return checkHarnessInstall(home, harnessId, options).state !== "missing";
}

/**
 * Which harnesses are confirmed installed on this machine, for the launcher's
 * status column. `unknown` ones aren't listed as detected.
 *
 * @param {string} home
 * @param {DetectOptions} [options]
 * @returns {import("./id.mjs").HarnessId[]}
 */
export function detectInstalledHarnesses(home, options = {}) {
  if (!home) {
    return [];
  }
  return Object.keys(harnessInstallSpecs(home, options))
    .filter((id) => checkHarnessInstall(home, id, options).state === "installed");
}

const LOGIN_PATH_START = "__NEXUS_LOGIN_PATH_START__";
const LOGIN_PATH_END = "__NEXUS_LOGIN_PATH_END__";

/**
 * The `PATH` a login shell sets up, which can hold dirs this process's `PATH`
 * lacks (an app launched from the Dock or Finder doesn't read shell profiles).
 * One spawn of `$SHELL -l`, bounded by `timeoutMs`; "" on Windows, on any
 * failure or timeout, under `NEXUS_TEST` (unless `shell` is passed), or with
 * `NEXUS_DETECT_LOGIN_SHELL=0`. Never throws.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, shell?: string, timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export function readLoginShellPath({ env = process.env, platform = process.platform, shell, timeoutMs = 2000 } = {}) {
  if (platform === "win32" || env.NEXUS_DETECT_LOGIN_SHELL === "0") {
    return Promise.resolve("");
  }
  if (!shell && env.NEXUS_TEST === "1") {
    return Promise.resolve("");
  }
  const shellPath = shell || env.SHELL || "/bin/sh";
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A profile may leave a background job holding the pipe open; don't
      // let it keep this process alive.
      try { child?.stdout?.destroy(); } catch { /* already closed */ }
      try { child?.unref(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch { /* already gone */ }
      finish("");
    }, timeoutMs);
    try {
      // `printenv` prints the exported, colon-joined PATH in any shell (fish
      // included); the markers skip whatever the profile itself prints.
      child = spawn(shellPath, ["-l", "-c", `echo ${LOGIN_PATH_START}; printenv PATH; echo ${LOGIN_PATH_END}`], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish("");
      return;
    }
    child.on("error", () => finish(""));
    child.on("exit", () => {
      // Give the pipe a moment to drain, then settle with what arrived.
      setTimeout(() => finish(parseLoginPath(output)), 50);
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(LOGIN_PATH_END)) {
        finish(parseLoginPath(output));
      }
    });
  });
}

/** The PATH between the markers, or "". */
function parseLoginPath(output) {
  const start = output.lastIndexOf(LOGIN_PATH_START);
  const end = output.indexOf(LOGIN_PATH_END, start);
  if (start < 0 || end < 0) return "";
  return output.slice(start + LOGIN_PATH_START.length, end).trim();
}

/**
 * `detectInstalledHarnesses`, plus commands found on the login shell's `PATH`
 * (see `readLoginShellPath`). The shell is spawned at most once, and only
 * when a harness that has a command isn't already detected.
 *
 * @param {string} home
 * @param {DetectOptions & { shell?: string, timeoutMs?: number }} [options]
 * @returns {Promise<import("./id.mjs").HarnessId[]>}
 */
export async function detectInstalledHarnessesAsync(home, options = {}) {
  const found = detectInstalledHarnesses(home, options);
  if (!home) {
    return found;
  }
  const specs = harnessInstallSpecs(home, options);
  const undetected = Object.keys(specs).some((id) => specs[id]?.commands.length && !found.includes(id));
  if (!undetected) {
    return found;
  }
  const loginPath = await readLoginShellPath(options);
  return loginPath ? detectInstalledHarnesses(home, { ...options, loginPath }) : found;
}
