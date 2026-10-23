import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  checkHarnessInstall,
  commandFallbackDirs,
  detectInstalledHarnesses,
  detectInstalledHarnessesAsync,
  findCommand,
  harnessInstallSpecs,
  hasFootprint,
  isHarnessInstalled,
  readLoginShellPath,
} from "../../lib/harness/detect.mjs";
import { HARNESSES } from "../../lib/harness/id.mjs";
import { withTempHome } from "../helpers.mjs";

const ALL = HARNESSES;

// Harnesses with no reliable install signal on a platform: never refused,
// never shown as detected. Anything else must have a spec.
const UNKNOWN = { darwin: [], linux: [], win32: ["claude-desktop", "copilot-app"] };

/**
 * Options that hide the host's own installs: PATH is one empty dir, the
 * machine-wide install root is a temp dir, and Windows env points under home.
 */
function sandbox(home, platform) {
  const bin = path.join(home, "bin");
  const root = path.join(home, "root");
  const localAppData = path.join(home, "AppData", "Local");
  const programFiles = path.join(root, "Program Files");
  const env = platform === "win32"
    ? { PATH: bin, PATHEXT: ".EXE;.CMD", LOCALAPPDATA: localAppData, ProgramFiles: programFiles }
    : { PATH: bin };
  return { bin, root, localAppData, programFiles, options: { env, platform, root } };
}

async function fakeFile(file, { executable = true } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  if (executable) await chmod(file, 0o755);
}

/** A folder with something in it: empty folders never count as an install. */
async function fakeDir(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".keep"), "");
}

const detected = (home, options) => new Set(detectInstalledHarnesses(home, options));

describe("findCommand", () => {
  it("finds an executable on PATH and skips non-executables", async () => {
    await withTempHome("detect-cmd-", async (home) => {
      const bin = path.join(home, "bin");
      await fakeFile(path.join(bin, "pi"));
      await fakeFile(path.join(bin, "dsh"), { executable: false });
      const options = { env: { PATH: bin }, platform: "linux" };
      assert.equal(findCommand("pi", options), path.join(bin, "pi"));
      assert.equal(findCommand("dsh", options), "");
      assert.equal(findCommand("codex", options), "");
    });
  });

  it("resolves PATHEXT extensions on Windows", async () => {
    await withTempHome("detect-cmd-win-", async (home) => {
      const bin = path.join(home, "bin");
      await fakeFile(path.join(bin, "copilot.CMD"), { executable: false });
      const env = { PATH: bin, PATHEXT: ".EXE;.CMD" };
      assert.equal(findCommand("copilot", { env, platform: "win32" }), path.join(bin, "copilot.CMD"));
      assert.equal(findCommand("pi", { env, platform: "win32" }), "");
    });
  });

  it("returns nothing for an empty PATH", () => {
    assert.equal(findCommand("node", { env: { PATH: "" } }), "");
  });
});

describe("harnessInstallSpecs", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    it(`${platform}: has a spec for every harness, null only where intended`, () => {
      const specs = harnessInstallSpecs("/home/test", { platform, env: {} });
      for (const id of HARNESSES) {
        assert.ok(Object.hasOwn(specs, id), `${platform}: ${id} has no entry`);
        assert.equal(specs[id] === null, UNKNOWN[platform].includes(id), `${platform}: ${id}`);
        if (specs[id]) {
          assert.ok(specs[id].hint, `${platform}: ${id} has no hint`);
        }
      }
    });
  }
});

describe("detectInstalledHarnesses", () => {
  it("returns nothing when home is blank", () => {
    assert.deepEqual(detectInstalledHarnesses(""), []);
  });

  for (const platform of ["darwin", "linux", "win32"]) {
    it(`${platform}: finds nothing on a clean machine, even with leftover config folders`, async () => {
      await withTempHome(`detect-empty-${platform}-`, async (home) => {
        const { options } = sandbox(home, platform);
        for (const dir of [".codex", ".pi", ".dsh", ".copilot", ".claude", ".config/opencode"]) {
          await mkdir(path.join(home, dir), { recursive: true });
        }
        const found = detected(home, options);
        for (const id of ALL) {
          assert.ok(!found.has(id), `${platform}: ${id}`);
          const { state } = checkHarnessInstall(home, id, options);
          assert.equal(state, UNKNOWN[platform].includes(id) ? "unknown" : "missing", `${platform}: ${id}`);
        }
      });
    });

    it(`${platform}: finds CLI harnesses from their commands on PATH`, async () => {
      await withTempHome(`detect-cli-${platform}-`, async (home) => {
        const { bin, options } = sandbox(home, platform);
        const ext = platform === "win32" ? ".CMD" : "";
        for (const name of ["claude", "codex", "opencode", "pi", "dsh", "copilot", "cursor", "code"]) {
          await fakeFile(path.join(bin, name + ext));
        }
        const found = detected(home, options);
        for (const id of ["claude", "codex", "opencode", "pi", "deepseek", "copilot-cli", "cursor", "vscode"]) {
          assert.ok(found.has(id), `${platform}: ${id}`);
        }
        if (platform !== "win32") {
          assert.ok(!found.has("copilot-app"), "the Copilot CLI doesn't install the app");
        }
      });
    });
  }

  it("darwin: finds apps in /Applications and ~/Applications", async () => {
    await withTempHome("detect-mac-apps-", async (home) => {
      const { root, options } = sandbox(home, "darwin");
      for (const name of ["Claude", "Cursor", "ChatGPT"]) {
        await fakeDir(path.join(root, "Applications", `${name}.app`));
      }
      await fakeDir(path.join(home, "Applications", "GitHub Copilot.app"));
      const found = detected(home, options);
      for (const id of ["claude-desktop", "cursor", "codex", "copilot-app"]) {
        assert.ok(found.has(id), id);
      }
    });
  });

  it("linux: finds desktop apps from their packages, AppImages, snap, and flatpak", async () => {
    await withTempHome("detect-linux-apps-", async (home) => {
      const { bin, options } = sandbox(home, "linux");
      await fakeFile(path.join(bin, "claude-desktop"));
      await fakeFile(path.join(bin, "github"));
      await fakeFile(path.join(home, "Applications", "Cursor-1.2.3-x86_64.AppImage"));
      await fakeFile(path.join(home, "Applications", "ChatGPT-x86_64.AppImage"));
      await fakeDir(path.join(home, ".local", "share", "flatpak", "app", "com.visualstudio.code"));
      const found = detected(home, options);
      for (const id of ["claude-desktop", "copilot-app", "cursor", "vscode", "codex"]) {
        assert.ok(found.has(id), id);
      }
      await withTempHome("detect-linux-pkg-", async (home2) => {
        const { root: root2, options: options2 } = sandbox(home2, "linux");
        await fakeFile(path.join(root2, "usr", "share", "cursor", "cursor"));
        await fakeDir(path.join(root2, "snap", "code"));
        await fakeFile(path.join(home2, "AppImages", "GitHub-Copilot-linux-x64.AppImage"));
        await fakeDir(path.join(root2, "opt", "ChatGPT"));
        const found2 = detected(home2, options2);
        for (const id of ["cursor", "vscode", "copilot-app", "codex"]) {
          assert.ok(found2.has(id), `pkg: ${id}`);
        }
      });
    });
  });

  it("win32: finds per-user installs and the Codex Store package", async () => {
    await withTempHome("detect-win-apps-", async (home) => {
      const { localAppData, options } = sandbox(home, "win32");
      await fakeFile(path.join(home, ".local", "bin", "claude.exe"));
      await fakeFile(path.join(home, ".opencode", "bin", "opencode.exe"));
      await fakeFile(path.join(localAppData, "Programs", "cursor", "Cursor.exe"));
      await fakeFile(path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"));
      await fakeDir(path.join(localAppData, "Packages", "OpenAI.Codex_2p2nqsd0c76g0"));
      const found = detected(home, options);
      for (const id of ["claude", "opencode", "cursor", "vscode", "codex"]) {
        assert.ok(found.has(id), id);
      }
    });
  });

  it("win32: Claude Desktop and the Copilot app are never refused, nor shown as detected", async () => {
    await withTempHome("detect-win-desktop-", async (home) => {
      const { options } = sandbox(home, "win32");
      const found = detected(home, options);
      for (const id of ["claude-desktop", "copilot-app"]) {
        assert.ok(isHarnessInstalled(home, id, options), id);
        assert.ok(!found.has(id), id);
      }
    });
  });

  it("linux: honors XDG_CONFIG_HOME for the apps' own logs, as the harnesses do", async () => {
    await withTempHome("detect-xdg-", async (home) => {
      const { options } = sandbox(home, "linux");
      const xdg = path.join(home, "xdg-config");
      const env = { ...options.env, XDG_CONFIG_HOME: xdg };
      await fakeDir(path.join(xdg, "Cursor", "logs"));
      await fakeDir(path.join(xdg, "Code", "logs"));
      const found = detected(home, { ...options, env });
      assert.ok(found.has("cursor"));
      assert.ok(found.has("vscode"));
    });
  });

  it("finds VS Code's machine-wide installs from its install module", async () => {
    await withTempHome("detect-vscode-product-", async (home) => {
      const { root, options } = sandbox(home, "linux");
      await fakeFile(path.join(root, "usr", "share", "code", "resources", "app", "product.json"));
      assert.ok(detected(home, options).has("vscode"));
    });
  });

  for (const platform of ["darwin", "linux", "win32"]) {
    it(`${platform}: counts data only the tool itself writes, off PATH`, async () => {
      await withTempHome(`detect-data-${platform}-`, async (home) => {
        const { options } = sandbox(home, platform);
        const userData = platform === "darwin"
          ? path.join(home, "Library", "Application Support")
          : platform === "win32" ? path.join(home, "AppData", "Roaming") : path.join(home, ".config");
        for (const dir of [
          ".claude/projects", ".codex/sessions", ".local/share/opencode", ".pi/agent/sessions", ".copilot/session-state",
        ]) {
          await fakeDir(path.join(home, dir));
        }
        await fakeDir(path.join(userData, "Cursor", "logs"));
        await fakeDir(path.join(userData, "Code", "logs"));
        const found = detected(home, options);
        for (const id of ["claude", "codex", "opencode", "pi", "copilot-cli", "cursor", "vscode"]) {
          assert.ok(found.has(id), `${platform}: ${id}`);
        }
        assert.ok(!found.has("deepseek"));
      });
    });
  }

  it("counts Claude Code and Codex used only as editor extensions", async () => {
    await withTempHome("detect-ext-", async (home) => {
      const { options } = sandbox(home, "linux");
      await fakeDir(path.join(home, ".cursor", "extensions", "anthropic.claude-code-2.1.0-darwin-arm64"));
      await fakeDir(path.join(home, ".vscode", "extensions", "openai.chatgpt-26.5.0"));
      const found = detected(home, options);
      assert.ok(found.has("claude"));
      assert.ok(found.has("codex"));
      assert.ok(!found.has("cursor"), "an extensions dir alone doesn't mean Cursor is installed");
    });
  });

  it("darwin: counts Claude Desktop from its own logs", async () => {
    await withTempHome("detect-desktop-logs-", async (home) => {
      const { options } = sandbox(home, "darwin");
      await fakeDir(path.join(home, "Library", "Logs", "Claude"));
      assert.ok(isHarnessInstalled(home, "claude-desktop", options));
    });
  });
});

describe("hasFootprint", () => {
  it("counts a file or a non-empty folder, never a missing path or an empty folder", async () => {
    await withTempHome("detect-footprint-", async (home) => {
      const empty = path.join(home, "empty");
      const full = path.join(home, "full");
      const file = path.join(home, "file");
      await mkdir(empty);
      await fakeDir(full);
      await writeFile(file, "");
      assert.equal(hasFootprint(path.join(home, "missing")), false);
      assert.equal(hasFootprint(empty), false);
      assert.equal(hasFootprint(full), true);
      assert.equal(hasFootprint(file), true);
    });
  });
});

describe("empty folders don't count as an install", () => {
  it("darwin: empty app bundles, logs, and session folders are ignored until they hold something", async () => {
    await withTempHome("detect-empty-footprints-", async (home) => {
      const { root, options } = sandbox(home, "darwin");
      const footprints = {
        "claude-desktop": path.join(root, "Applications", "Claude.app"),
        cursor: path.join(home, "Applications", "Cursor.app"),
        codex: path.join(home, ".codex", "sessions"),
        claude: path.join(home, ".claude", "projects"),
        "copilot-app": path.join(root, "Applications", "GitHub Copilot.app"),
        "copilot-cli": path.join(home, ".copilot", "session-state"),
        deepseek: path.join(home, ".dsh", "profiles"),
      };
      for (const dir of Object.values(footprints)) {
        await mkdir(dir, { recursive: true });
      }
      let found = detected(home, options);
      for (const id of Object.keys(footprints)) {
        assert.ok(!found.has(id), `empty: ${id}`);
      }
      for (const dir of Object.values(footprints)) {
        await fakeDir(dir);
      }
      found = detected(home, options);
      for (const id of Object.keys(footprints)) {
        assert.ok(found.has(id), `non-empty: ${id}`);
      }
    });
  });

  it("an empty ~/.dsh left by `on`/`off` isn't DeepSeek Harness, nor is one holding only Nexus's settings", async () => {
    await withTempHome("detect-dsh-leftover-", async (home) => {
      const { options } = sandbox(home, "darwin");
      await mkdir(path.join(home, ".dsh"));
      assert.equal(checkHarnessInstall(home, "deepseek", options).state, "missing");
      await writeFile(path.join(home, ".dsh", "settings.yaml"), "providers: {}\n");
      assert.equal(checkHarnessInstall(home, "deepseek", options).state, "missing");
    });
  });
});

describe("commands off PATH", () => {
  it("unix: finds commands in the usual install dirs when PATH lacks them", async () => {
    await withTempHome("detect-fallback-", async (home) => {
      const { root, options } = sandbox(home, "darwin");
      const placed = {
        codex: path.join(home, ".npm-global", "bin", "codex"),
        pi: path.join(home, ".volta", "bin", "pi"),
        opencode: path.join(home, ".bun", "bin", "opencode"),
        cursor: path.join(root, "opt", "homebrew", "bin", "cursor"),
        vscode: path.join(root, "usr", "local", "bin", "code-insiders"),
        deepseek: path.join(root, "usr", "bin", "dsh"),
        "copilot-cli": path.join(home, ".local", "bin", "copilot"),
      };
      for (const file of Object.values(placed)) {
        await fakeFile(file);
      }
      const found = detected(home, options);
      for (const id of Object.keys(placed)) {
        assert.ok(found.has(id), id);
      }
      assert.ok(!found.has("copilot-app"), "the Copilot CLI doesn't install the app");
    });
  });

  it("unix: a non-executable file in a fallback dir doesn't count", async () => {
    await withTempHome("detect-fallback-noexec-", async (home) => {
      const { options } = sandbox(home, "linux");
      await fakeFile(path.join(home, ".bun", "bin", "pi"), { executable: false });
      assert.ok(!detected(home, options).has("pi"));
    });
  });

  it("win32: finds npm global commands under %APPDATA%\\npm", async () => {
    await withTempHome("detect-fallback-win-", async (home) => {
      const { options } = sandbox(home, "win32");
      const appData = path.join(home, "AppData", "Roaming");
      await fakeFile(path.join(appData, "npm", "copilot.CMD"), { executable: false });
      await fakeFile(path.join(appData, "npm", "dsh.CMD"), { executable: false });
      const found = detected(home, { ...options, env: { ...options.env, APPDATA: appData } });
      assert.ok(found.has("copilot-cli"));
      assert.ok(found.has("deepseek"));
    });
  });

  it("lists the fallback dirs under `root` so specs never see the host's", () => {
    const dirs = commandFallbackDirs("/home/test", { platform: "linux", env: {}, root: "/sandbox" });
    for (const dir of dirs) {
      assert.ok(dir.startsWith("/home/test") || dir.startsWith("/sandbox"), dir);
    }
  });

  it("searches an extra `loginPath`", async () => {
    await withTempHome("detect-login-path-", async (home) => {
      const { options } = sandbox(home, "linux");
      const nvmBin = path.join(home, ".nvm", "versions", "node", "v22.0.0", "bin");
      await fakeFile(path.join(nvmBin, "codex"));
      assert.ok(!detected(home, options).has("codex"));
      assert.ok(detected(home, { ...options, loginPath: nvmBin }).has("codex"));
    });
  });
});

describe("app bundles and program folders", () => {
  it("darwin: finds Codex.app and VS Code (stable or Insiders) in either Applications folder", async () => {
    await withTempHome("detect-mac-bundles-", async (home) => {
      const { root, options } = sandbox(home, "darwin");
      await fakeDir(path.join(root, "Applications", "Codex.app", "Contents"));
      await fakeDir(path.join(home, "Applications", "Visual Studio Code - Insiders.app", "Contents"));
      const found = detected(home, options);
      assert.ok(found.has("codex"));
      assert.ok(found.has("vscode"));
    });
    await withTempHome("detect-mac-vscode-", async (home) => {
      const { options } = sandbox(home, "darwin");
      await fakeDir(path.join(home, "Applications", "Visual Studio Code.app", "Contents"));
      assert.ok(detected(home, options).has("vscode"));
    });
  });

  it("win32: finds Cursor and VS Code from their folders under %LOCALAPPDATA%\\Programs", async () => {
    await withTempHome("detect-win-programs-", async (home) => {
      const { localAppData, options } = sandbox(home, "win32");
      const cursorDir = path.join(localAppData, "Programs", "cursor");
      const insidersDir = path.join(localAppData, "Programs", "Microsoft VS Code Insiders");
      await mkdir(cursorDir, { recursive: true });
      await mkdir(insidersDir, { recursive: true });
      let found = detected(home, options);
      assert.ok(!found.has("cursor"), "an empty program folder doesn't count");
      assert.ok(!found.has("vscode"), "an empty program folder doesn't count");
      await fakeDir(cursorDir);
      await fakeDir(insidersDir);
      found = detected(home, options);
      assert.ok(found.has("cursor"));
      assert.ok(found.has("vscode"));
    });
  });

  it("linux: finds VS Code Insiders from its own logs", async () => {
    await withTempHome("detect-insiders-logs-", async (home) => {
      const { options } = sandbox(home, "linux");
      await fakeDir(path.join(home, ".config", "Code - Insiders", "logs"));
      assert.ok(detected(home, options).has("vscode"));
    });
  });
});

describe("env var overrides", () => {
  it("COPILOT_HOME moves the Copilot CLI's session history", async () => {
    await withTempHome("detect-copilot-home-", async (home) => {
      const { options } = sandbox(home, "linux");
      const copilotHome = path.join(home, "elsewhere", "copilot");
      const env = { ...options.env, COPILOT_HOME: copilotHome };
      await fakeDir(path.join(home, ".copilot", "session-state"));
      assert.ok(!detected(home, { ...options, env }).has("copilot-cli"), "~/.copilot is ignored once COPILOT_HOME is set");
      await fakeDir(path.join(copilotHome, "session-state"));
      assert.ok(detected(home, { ...options, env }).has("copilot-cli"));
    });
  });

  it("COPILOT_HOME: the files `on` writes count as neither the app nor the CLI", async () => {
    await withTempHome("detect-copilot-written-", async (home) => {
      const { options } = sandbox(home, "darwin");
      const copilotHome = path.join(home, "copilot-home");
      const env = { ...options.env, COPILOT_HOME: copilotHome };
      await mkdir(copilotHome, { recursive: true });
      await writeFile(path.join(copilotHome, "providers.json"), "{}");
      await writeFile(path.join(copilotHome, "settings.json"), "{}");
      await writeFile(path.join(copilotHome, "data.db"), "");
      const found = detected(home, { ...options, env });
      assert.ok(!found.has("copilot-cli"));
      assert.ok(!found.has("copilot-app"));
    });
  });

  it("DSH_HOME moves DeepSeek Harness's profiles", async () => {
    await withTempHome("detect-dsh-home-", async (home) => {
      const { options } = sandbox(home, "linux");
      const dshHome = path.join(home, "dsh-elsewhere");
      const env = { ...options.env, DSH_HOME: dshHome };
      await fakeDir(path.join(home, ".dsh", "profiles", "default"));
      assert.ok(!detected(home, { ...options, env }).has("deepseek"), "~/.dsh is ignored once DSH_HOME is set");
      await fakeDir(path.join(dshHome, "profiles", "default"));
      assert.ok(detected(home, { ...options, env }).has("deepseek"));
    });
  });
});

describe("login shell PATH", () => {
  /** A stand-in for `$SHELL` that prints profile noise, then runs `-c`. */
  async function fakeShell(home, { extraPath = "", sleep = 0 } = {}) {
    const file = path.join(home, "fake-shell");
    const body = [
      "#!/bin/sh",
      'while [ "$1" != "-c" ]; do shift; done',
      "echo 'Welcome! (profile output)'",
      sleep ? `sleep ${sleep}` : "",
      `PATH="${extraPath ? `${extraPath}:` : ""}$PATH:/usr/bin:/bin"; export PATH`,
      'exec /bin/sh -c "$2"',
    ].join("\n");
    await writeFile(file, `${body}\n`);
    await chmod(file, 0o755);
    return file;
  }

  const unixOnly = { skip: process.platform === "win32" && "needs a POSIX shell" };

  it("reads the PATH a login shell sets up, ignoring what its profile prints", unixOnly, async () => {
    await withTempHome("detect-login-shell-", async (home) => {
      const shell = await fakeShell(home, { extraPath: "/from/profile/bin" });
      const loginPath = await readLoginShellPath({ shell, env: { PATH: "/usr/bin:/bin" }, platform: process.platform });
      assert.ok(loginPath.split(":").includes("/from/profile/bin"), loginPath);
      assert.ok(!loginPath.includes("Welcome"), loginPath);
    });
  });

  it("gives up after the timeout instead of hanging", unixOnly, async () => {
    await withTempHome("detect-login-shell-slow-", async (home) => {
      const shell = await fakeShell(home, { sleep: 5 });
      const started = Date.now();
      const loginPath = await readLoginShellPath({ shell, env: { PATH: "/usr/bin:/bin" }, platform: process.platform, timeoutMs: 200 });
      assert.equal(loginPath, "");
      assert.ok(Date.now() - started < 2000);
    });
  });

  it("returns nothing for a shell that can't start", async () => {
    const loginPath = await readLoginShellPath({ shell: "/nonexistent/shell", env: {}, platform: "linux" });
    assert.equal(loginPath, "");
  });

  it("never spawns on Windows, under NEXUS_TEST, or with the kill switch", async () => {
    assert.equal(await readLoginShellPath({ platform: "win32", shell: "/bin/sh" }), "");
    assert.equal(await readLoginShellPath({ platform: "linux", env: { NEXUS_TEST: "1", SHELL: "/bin/sh" } }), "");
    assert.equal(await readLoginShellPath({ platform: "linux", shell: "/bin/sh", env: { NEXUS_DETECT_LOGIN_SHELL: "0" } }), "");
  });

  it("detectInstalledHarnessesAsync adds commands only the login shell's PATH has", unixOnly, async () => {
    await withTempHome("detect-async-", async (home) => {
      const { options } = sandbox(home, "linux");
      const nvmBin = path.join(home, "nvm-bin");
      await fakeFile(path.join(nvmBin, "opencode"));
      const shell = await fakeShell(home, { extraPath: nvmBin });
      assert.ok(!detected(home, options).has("opencode"));
      const found = await detectInstalledHarnessesAsync(home, { ...options, shell });
      assert.ok(found.includes("opencode"));
      assert.deepEqual(await detectInstalledHarnessesAsync("", { ...options, shell }), []);
    });
  });
});
