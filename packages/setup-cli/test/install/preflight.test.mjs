import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const INSTALL_PATH = path.join(REPO_ROOT, "install.sh");
const PROMPT = `Claude Code is currently connected through FireConnect.

FireConnect must temporarily restore your original Claude settings before upgrading.

Continue? [Y/n]`;
const BASE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const HAS_UTIL_LINUX_SCRIPT = spawnSync("script", ["--version"], {
  encoding: "utf8",
}).status === 0;

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createRunner(root) {
  const installSource = await readFile(INSTALL_PATH, "utf8");
  const runner = path.join(root, "preflight-runner.sh");
  await writeFile(
    runner,
    installSource.replace(
      /\nmain "\$@"\s*$/,
      "\npreflight_existing_install\nprint_claude_restore_summary\nprintf 'restored=%s\\n' \"${CLAUDE_SETTINGS_RESTORED}\"\n",
    ),
  );
  return runner;
}

async function createFakeCli(home) {
  const launcher = path.join(home, ".local/bin/fireconnect");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(
    launcher,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${NEXUS_FAKE_LOG}"
if [[ "\${NEXUS_FAKE_MODE:-success}" == "fail" ]]; then
  exit 9
fi
if [[ "\${NEXUS_FAKE_MODE:-success}" == "noop" ]]; then
  exit 0
fi
if [[ -n "\${NEXUS_AFTER_CONFIG:-}" ]]; then
  cp "\${NEXUS_AFTER_CONFIG}" "\${HOME}/.nexus/config.json"
fi
if [[ -n "\${NEXUS_AFTER_SETTINGS:-}" ]]; then
  mkdir -p "\${HOME}/.claude"
  cp "\${NEXUS_AFTER_SETTINGS}" "\${HOME}/.claude/settings.json"
else
  rm -f "\${HOME}/.claude/settings.json"
fi
rm -f "\${HOME}/.nexus/claude/provider-backup.json"
rm -f "\${HOME}/.nexus/claude/provider-state.json"
`,
  );
  await chmod(launcher, 0o755);
}

async function withFixture(name, callback, { installed = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `fc-install-${name}-`));
  const home = path.join(root, "home");
  const logPath = path.join(root, "fake-cli.log");
  await mkdir(home, { recursive: true });
  const runner = await createRunner(root);
  if (installed) {
    await createFakeCli(home);
  }
  try {
    await callback({ root, home, logPath, runner });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runPreflight({ home, logPath, runner }, env = {}) {
  return spawnSync("bash", [runner], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: BASE_PATH,
      SHELL: "/bin/bash",
      NEXUS_FAKE_LOG: logPath,
      ...env,
    },
  });
}

function runPreflightInPty({ home, logPath, runner }, input, env = {}) {
  return spawnSync(
    "script",
    ["-qfec", 'bash "$NEXUS_TEST_RUNNER"', "/dev/null"],
    {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        HOME: home,
        PATH: BASE_PATH,
        SHELL: "/bin/bash",
        NEXUS_FAKE_LOG: logPath,
        NEXUS_TEST_RUNNER: runner,
        ...env,
      },
    },
  );
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

describe("install.sh Claude upgrade preflight", () => {
  it("skips Claude-off when the installed FireConnect is 0.9.0+", async () => {
    await withFixture("skip-modern", async (fixture) => {
      await writeJson(path.join(fixture.home, ".nexus/config.json"), {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      await writeJson(
        path.join(fixture.home, ".nexus/cli/packages/setup-cli/package.json"),
        { name: "fireconnect", version: "0.9.0" },
      );

      const result = runPreflight(fixture, {
        // Would force off if detection ran — assert it never reaches the CLI.
        NEXUS_AUTO_OFF_CLAUDE: "1",
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readIfExists(fixture.logPath), "");
      assert.match(result.stdout, /restored=0/);
    });
  });

  it("still restores Claude when upgrading from FireConnect before 0.9.0", async () => {
    await withFixture("legacy-version", async (fixture) => {
      const configPath = path.join(fixture.home, ".nexus/config.json");
      const afterConfig = path.join(fixture.root, "config-after.json");
      await writeJson(configPath, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      await writeJson(afterConfig, {
        harnesses: { claude: { enabled: false, provider: "fireworks" } },
      });
      await writeJson(
        path.join(fixture.home, ".nexus/cli/packages/setup-cli/package.json"),
        { name: "fireconnect", version: "0.8.9" },
      );

      const result = runPreflight(fixture, {
        NEXUS_AUTO_OFF_CLAUDE: "1",
        NEXUS_AFTER_CONFIG: afterConfig,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      assert.match(result.stdout, /restored=1/);
    });
  });

  it("uses the top-level off for releases before 0.4.0, which have no `claude off`", async () => {
    await withFixture("pre-harness-cli", async (fixture) => {
      const afterConfig = path.join(fixture.root, "config-after.json");
      await writeJson(path.join(fixture.home, ".nexus/config.json"), {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      await writeJson(afterConfig, {
        harnesses: { claude: { enabled: false, provider: "fireworks" } },
      });
      // v0.3.0 and the initial release both shipped with package version 0.2.0.
      await writeJson(
        path.join(fixture.home, ".nexus/cli/packages/setup-cli/package.json"),
        { name: "fireconnect", version: "0.2.0" },
      );

      const result = runPreflight(fixture, {
        NEXUS_AUTO_OFF_CLAUDE: "1",
        NEXUS_AFTER_CONFIG: afterConfig,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.logPath, "utf8"), "off\n");
      assert.match(result.stdout, /restored=1/);
    });
  });

  it("uses the existing CLI to disable a globally enabled Claude harness", async () => {
    await withFixture("global", async (fixture) => {
      const configPath = path.join(fixture.home, ".nexus/config.json");
      const afterConfig = path.join(fixture.root, "config-after.json");
      await writeJson(configPath, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      await writeJson(afterConfig, {
        harnesses: { claude: { enabled: false, provider: "fireworks" } },
      });

      const result = runPreflight(fixture, {
        NEXUS_AUTO_OFF_CLAUDE: "1",
        NEXUS_AFTER_CONFIG: afterConfig,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      assert.match(result.stdout, /restored=1/);
      assert.match(
        result.stdout,
        /Your original Claude Code settings were restored before the upgrade\./,
      );
      assert.match(
        result.stdout,
        /Reconnect Claude Code through Nexus: nexus claude/,
      );
    });
  });

  it("detects managed Fireworks settings when global state is missing", async () => {
    await withFixture("settings", async (fixture) => {
      const settingsPath = path.join(fixture.home, ".claude/settings.json");
      const afterSettings = path.join(fixture.root, "settings-after.json");
      await writeJson(settingsPath, {
        env: {
          ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
          ANTHROPIC_CUSTOM_HEADERS: "X-Title: Claude Code",
        },
      });
      await writeJson(afterSettings, { theme: "dark" });

      const result = runPreflight(fixture, {
        NEXUS_AUTO_OFF_CLAUDE: "1",
        NEXUS_AFTER_SETTINGS: afterSettings,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        theme: "dark",
      });
    });
  });

  it("detects backup-less short-slug settings without telemetry", async () => {
    await withFixture("short-slug-settings", async (fixture) => {
      const settingsPath = path.join(fixture.home, ".claude/settings.json");
      const afterSettings = path.join(fixture.root, "settings-after.json");
      await writeJson(settingsPath, {
        env: {
          ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
          ANTHROPIC_MODEL: "glm-fast-latest[1m]",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-fast-latest",
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key",
        },
      });
      await writeJson(afterSettings, { theme: "dark" });

      const result = runPreflight(fixture, {
        NEXUS_AUTO_OFF_CLAUDE: "1",
        NEXUS_AFTER_SETTINGS: afterSettings,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        theme: "dark",
      });
      assert.match(result.stdout, /restored=1/);
    });
  });

  it("does not claim an unmanaged Fireworks hostname", async () => {
    await withFixture("unmanaged", async (fixture) => {
      await writeJson(path.join(fixture.home, ".claude/settings.json"), {
        env: {
          ANTHROPIC_BASE_URL: "https://custom.fireworks.ai/inference",
          ANTHROPIC_MODEL: "glm-fast-latest",
        },
      });

      const result = runPreflight(fixture);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readIfExists(fixture.logPath), "");
      assert.match(result.stdout, /restored=0/);
      assert.doesNotMatch(result.stdout, /Reconnect Claude Code/);
    });
  });

  it("stops without a controlling terminal and leaves Claude untouched", async () => {
    await withFixture("no-tty", async (fixture) => {
      await writeJson(path.join(fixture.home, ".nexus/config.json"), {
        harnesses: { claude: { enabled: true } },
      });

      const result = runPreflight(fixture);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no interactive terminal is available/);
      assert.match(result.stderr, /NEXUS_AUTO_OFF_CLAUDE=1/);
      assert.equal(await readIfExists(fixture.logPath), "");
    });
  });

  it(
    "prints the approved prompt through a TTY and stops when declined",
    { skip: !HAS_UTIL_LINUX_SCRIPT },
    async () => {
      await withFixture("decline", async (fixture) => {
        await writeJson(path.join(fixture.home, ".nexus/config.json"), {
          harnesses: { claude: { enabled: true } },
        });

        const result = runPreflightInPty(fixture, "n\n");
        const transcript = result.stdout.replaceAll("\r", "");

        assert.notEqual(result.status, 0);
        assert.match(transcript, new RegExp(PROMPT.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(transcript, /Installation cancelled/);
        assert.equal(await readIfExists(fixture.logPath), "");
      });
    },
  );

  it(
    "accepts the prompt default and runs the existing CLI",
    { skip: !HAS_UTIL_LINUX_SCRIPT },
    async () => {
      await withFixture("accept", async (fixture) => {
        const configPath = path.join(fixture.home, ".nexus/config.json");
        const afterConfig = path.join(fixture.root, "config-after.json");
        await writeJson(configPath, {
          harnesses: { claude: { enabled: true } },
        });
        await writeJson(afterConfig, {
          harnesses: { claude: { enabled: false } },
        });

        const result = runPreflightInPty(fixture, "\n", {
          NEXUS_AFTER_CONFIG: afterConfig,
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      });
    },
  );

  it("fails closed when the existing CLI leaves Claude managed", async () => {
    await withFixture("noop", async (fixture) => {
      await writeJson(path.join(fixture.home, ".nexus/config.json"), {
        harnesses: { claude: { enabled: true } },
      });

      const result = runPreflight(fixture, {
        NEXUS_AUTO_OFF_CLAUDE: "1",
        NEXUS_FAKE_MODE: "noop",
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Claude Code is still managed/);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
    });
  });

  it("fails closed when the existing CLI cannot disable Claude", async () => {
    await withFixture("failure", async (fixture) => {
      await writeJson(path.join(fixture.home, ".nexus/config.json"), {
        harnesses: { claude: { enabled: true } },
      });

      const result = runPreflight(fixture, {
        NEXUS_AUTO_OFF_CLAUDE: "1",
        NEXUS_FAKE_MODE: "fail",
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /could not restore Claude Code settings/);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
    });
  });

  it("leaves first-time installs unaffected", async () => {
    await withFixture("first", async (fixture) => {
      const result = runPreflight(fixture);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /restored=0/);
      assert.doesNotMatch(result.stdout, /Claude Code is currently connected/);
    }, { installed: false });
  });

  it("runs the preflight before source setup", async () => {
    const installSource = await readFile(INSTALL_PATH, "utf8");
    assert.match(
      installSource,
      /ensure_node_runtime\n  check_names_are_ours\n  migrate_legacy_data_dir\n  preflight_existing_install\n  ensure_durable_source/,
    );
  });
});

describe("install.sh finish screen", () => {
  it("shows the banner once and prints quick help at the end", async () => {
    const installSource = await readFile(INSTALL_PATH, "utf8");
    assert.equal((installSource.match(/node "\$\{banner_script\}"/g) ?? []).length, 1);
    assert.match(installSource, /node "\$\{banner_script\}" --context install\n/);
    assert.match(installSource, /node "\$\{CLI\}" help quick/);
    assert.doesNotMatch(installSource, /node "\$\{CLI\}" help\n/);
    assert.doesNotMatch(installSource, /--success-only/);
  });

  it("print_install_notes tolerates an empty INSTALL_NOTES array under set -u", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fireconnect-install-notes-"));
    try {
      const installSource = await readFile(INSTALL_PATH, "utf8");
      const printInstallNotes = installSource.match(
        /^print_install_notes\(\) \{[\s\S]*?^\}/m,
      )?.[0];
      assert.ok(printInstallNotes, "expected print_install_notes in install.sh");
      assert.match(
        printInstallNotes,
        /\(\(\$\{#INSTALL_NOTES\[@\]\}\)\)/,
        "expected empty-array guard for set -u compatibility",
      );

      const runner = path.join(root, "notes-runner.sh");
      await writeFile(
        runner,
        `#!/usr/bin/env bash
set -euo pipefail
INSTALL_NOTES=()
${printInstallNotes}
print_install_notes
echo notes-ok
`,
      );
      await chmod(runner, 0o755);

      const result = spawnSync("bash", [runner], { encoding: "utf8" });
      assert.equal(
        result.status,
        0,
        result.stderr || result.stdout,
      );
      assert.match(result.stdout, /notes-ok/);
      assert.doesNotMatch(result.stdout, /^Note:/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("install.sh download", () => {
  async function runDownload(root, home, source) {
    const installSource = await readFile(INSTALL_PATH, "utf8");
    const runner = path.join(root, "download-runner.sh");
    await writeFile(
      runner,
      installSource.replace(/\nmain "\$@"\s*$/, '\nCLI=""\nSOURCE="$NEXUS_TEST_SOURCE"\nensure_durable_source\necho "cli=${CLI}"\n'),
    );
    return spawnSync("bash", [runner], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, NEXUS_TEST_SOURCE: source },
    });
  }

  async function withInstalledCli(callback) {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-install-download-"));
    const home = path.join(root, "home");
    const installed = path.join(home, ".nexus/cli/packages/setup-cli/bin/nexus.mjs");
    await mkdir(path.dirname(installed), { recursive: true });
    await writeFile(installed, "// installed\n");
    try {
      await callback({ root, home, installed });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("keeps the existing install when the download fails", async () => {
    await withInstalledCli(async ({ root, home, installed }) => {
      const result = await runDownload(root, home, path.join(root, "missing.git"));

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /your existing install was left in place/);
      assert.equal(await readFile(installed, "utf8"), "// installed\n");
      assert.equal(existsSync(path.join(home, ".nexus/cli.download")), false);
    });
  });

  it("swaps in a complete download", async () => {
    await withInstalledCli(async ({ root, home, installed }) => {
      const source = path.join(root, "source");
      await mkdir(path.join(source, "packages/setup-cli/bin"), { recursive: true });
      await writeFile(path.join(source, "packages/setup-cli/bin/nexus.mjs"), "// downloaded\n");
      const git = (...args) => spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "init");

      const result = await runDownload(root, home, source);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /cli=.*\.nexus\/cli\/packages\/setup-cli\/bin\/nexus\.mjs/);
      assert.equal(await readFile(installed, "utf8"), "// downloaded\n");
    });
  });
});

describe("install.sh names that belong to another program", () => {
  async function runCheck(home) {
    const source = await readFile(INSTALL_PATH, "utf8");
    const fn = (name) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m"))?.[0];
    const runner = path.join(home, "..", "check-runner.sh");
    await writeFile(runner, [fn("foreign_launcher"), fn("foreign_data_dir"), fn("check_names_are_ours"), "check_names_are_ours"].join("\n"));
    return spawnSync("bash", [runner], { encoding: "utf8", env: { ...process.env, HOME: home } });
  }

  async function withHome(callback) {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-install-names-"));
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".local/bin"), { recursive: true });
    try {
      await callback(home);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("stops before changing anything when another program owns ~/.local/bin/nexus", async () => {
    await withHome(async (home) => {
      await writeFile(path.join(home, ".local/bin/nexus"), "#!/bin/sh\nexec other-tool\n");
      const result = await runCheck(home);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /\.local\/bin\/nexus belongs to another program/);
      assert.equal(await readFile(path.join(home, ".local/bin/nexus"), "utf8"), "#!/bin/sh\nexec other-tool\n");
    });
  });

  it("stops when ~/.nexus holds another program's files", async () => {
    await withHome(async (home) => {
      await mkdir(path.join(home, ".nexus"));
      await writeFile(path.join(home, ".nexus/settings.ini"), "other=1\n");
      const result = await runCheck(home);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /~\/\.nexus belongs to another program/);
    });
  });

  it("goes ahead over our own launchers and data directory", async () => {
    await withHome(async (home) => {
      const ours = `#!/usr/bin/env bash\nexec node "${home}/.nexus/cli/packages/setup-cli/bin/nexus.mjs" "$@"\n`;
      await writeFile(path.join(home, ".local/bin/nexus"), ours);
      await mkdir(path.join(home, ".nexus"));
      await writeFile(path.join(home, ".nexus/config.json"), JSON.stringify({ harnesses: {} }));
      const result = await runCheck(home);
      assert.equal(result.status, 0, result.stderr);
    });
  });
});

describe("install.sh data directory move", () => {
  async function runMove(home) {
    const source = await readFile(INSTALL_PATH, "utf8");
    const fn = source.match(/^migrate_legacy_data_dir\(\) \{[\s\S]*?^\}$/m)[0];
    const runner = path.join(home, "..", "move-runner.sh");
    await writeFile(runner, ['install_note() { echo "NOTE: $*"; }', fn, "migrate_legacy_data_dir"].join("\n"));
    return spawnSync("bash", [runner], { encoding: "utf8", env: { ...process.env, HOME: home } });
  }

  it("moves ~/.fireconnect to ~/.nexus and leaves a relative link behind", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-install-move-"));
    const home = path.join(root, "home");
    try {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      const result = await runMove(home);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /NOTE: Moved ~\/\.fireconnect to ~\/\.nexus\.$/m);
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
      assert.equal(await readFile(path.join(home, ".fireconnect/config.json"), "utf8"), "{}\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("install.sh shared finalize", () => {
  it("invokes fireconnect finalize-install after installing the launcher", async () => {
    const source = await readFile(INSTALL_PATH, "utf8");
    assert.match(source, /node "\$\{CLI\}" finalize-install/);
    assert.match(source, /Finalizing install/);
  });
});
