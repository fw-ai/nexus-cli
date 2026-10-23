import { mkdtemp, readFile, writeFile, mkdir, access, lstat, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { codexBackupPath, codexConfigPath, codexDataDir, CODEX_CATALOG_TOML_REF } from "../../lib/harnesses/codex/core.mjs";
import { patchCodexCatalogRefRaw } from "../../lib/harnesses/codex/toml-patch.mjs";
import { globalConfigPath, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { writeJson } from "../../lib/io/json.mjs";
import { runFireconnect } from "../helpers.mjs";
import * as registry from "../../lib/harness/registry.mjs";
import { HARNESS } from "../../lib/harness/id.mjs";
import { runUninstallCommand } from "../../lib/cli/commands/global.mjs";

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("uninstall", () => {
  it("restores claude, opencode, and codex then removes state", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-"));
    const settingsDir = path.join(home, ".claude");
    const opencodeDir = path.join(home, ".config/opencode");
    const codexDir = path.join(home, ".codex");
    await mkdir(settingsDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });

    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-original" } }),
    );

    const configPath = opencodeConfigPath(home);
    const opencodeOriginal = JSON.stringify({ model: "openai/gpt-4" }, null, 2) + "\n";
    await writeFile(configPath, opencodeOriginal);

    const codexPath = codexConfigPath(home);
    const codexOriginal = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
    ].join("\n") + "\n";
    await writeFile(codexPath, codexOriginal);

    await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], { HOME: home });
    await runFireconnect(["opencode", "on", "--api-key", "fw_test_key_12345"], { HOME: home });
    await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );

    // Regression (gh fw-ai/nexus-cli#12): a leftover ~/.nexus file
    // (e.g. the update-check cache) must not survive uninstall.
    await writeFile(path.join(home, ".nexus/update-check.json"), '{"lastCheck":1}');

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);

    const restoredClaude = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restoredClaude.env.ANTHROPIC_API_KEY, "sk-ant-original");

    const restoredOpencode = await readFile(configPath, "utf8");
    assert.equal(restoredOpencode, opencodeOriginal);

    const restoredCodex = await readFile(codexPath, "utf8");
    assert.equal(restoredCodex, codexOriginal);

    assert.equal(await pathExists(globalConfigPath(home)), false);
    assert.equal(await pathExists(path.join(home, ".nexus/claude")), false);
    assert.equal(await pathExists(path.join(home, ".nexus/opencode")), false);
    assert.equal(await pathExists(path.join(home, ".nexus/codex")), false);
    assert.equal(await pathExists(path.join(home, ".codex/fireworks-model-catalog.json")), false);
    // gh #12: nothing left in ~/.nexus, and the dir itself is gone.
    assert.equal(await pathExists(path.join(home, ".nexus/update-check.json")), false);
    assert.equal(await pathExists(path.join(home, ".nexus")), false);
  });

  it("restores codex from a legacy fireworks-azure routing on uninstall", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-legacy-azure-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    // The state an Azure-enabled install is left in after the Azure removal:
    // config.toml still routes through fireworks-azure (which Codex CLI 0.160+
    // refuses to load), and the pre-Nexus snapshot is the only way back.
    const configPath = codexConfigPath(home);
    const codexOriginal = 'model = "gpt-4.1"\n';
    const legacyAzureRouting = [
      'model_provider = "fireworks-azure"',
      'model = "FW-GLM-5.2"',
      "",
      "[model_providers.fireworks-azure]",
      'name = "Fireworks Azure"',
      'base_url = "https://example-resource.services.ai.azure.com/openai/v1"',
      'wire_api = "chat"',
      'env_key = "AZURE_API_KEY"',
      "requires_openai_auth = false",
    ].join("\n") + "\n";
    await writeFile(configPath, legacyAzureRouting);

    const backupPath = codexBackupPath(codexDataDir(home), configPath);
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: codexOriginal },
    });

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0, uninstallResult.stderr);

    assert.equal(await readFile(configPath, "utf8"), codexOriginal);
    assert.equal(await pathExists(path.join(home, ".nexus/codex")), false);
  });

  it("keeps codex catalog when uninstall cannot disable codex", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-codex-off-fail-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );

    const configPath = codexConfigPath(home);
    const catalogPath = path.join(home, ".codex/fireworks-model-catalog.json");
    await writeFile(
      configPath,
      patchCodexCatalogRefRaw(await readFile(configPath, "utf8"), CODEX_CATALOG_TOML_REF),
      "utf8",
    );
    await writeFile(catalogPath, '{"models":[]}', "utf8");

    const backupPath = codexBackupPath(codexDataDir(home), configPath);
    await writeJson(backupPath, {
      configPath: "/different/config.toml",
      snapshot: { existed: true, raw: 'model = "gpt-4.1"\n' },
    });

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.notEqual(uninstallResult.code, 0);
    assert.match(uninstallResult.stderr, /failed to restore codex/i);
    assert.equal(await pathExists(catalogPath), true);
    assert.match(await readFile(configPath, "utf8"), /model_catalog_json/);
  });

  it("keeps codex catalog on uninstall when restored config still references it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-keep-catalog-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );

    const configPath = codexConfigPath(home);
    const catalogPath = path.join(home, ".codex/fireworks-model-catalog.json");
    await writeFile(
      configPath,
      patchCodexCatalogRefRaw(await readFile(configPath, "utf8"), CODEX_CATALOG_TOML_REF),
      "utf8",
    );
    await writeFile(catalogPath, '{"models":[]}', "utf8");

    const original = [
      'model_provider = "openai"',
      `model_catalog_json = "${CODEX_CATALOG_TOML_REF}"`,
      'model = "gpt-4.1"',
      "",
    ].join("\n");
    await writeJson(codexBackupPath(codexDataDir(home), configPath), {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: original },
    });

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.equal(await pathExists(catalogPath), true);

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);
    assert.equal(await pathExists(catalogPath), true);
    assert.match(await readFile(configPath, "utf8"), /model_catalog_json/);
  });

  it("does not mutate settings when harness was configured but not enabled", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-config-only-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });

    const settingsPath = userSettingsPath(home);
    const originalSettings = JSON.stringify({
      env: { ANTHROPIC_API_KEY: "sk-ant-original" },
    });
    await writeFile(settingsPath, originalSettings);

    // Harness registered (present in config) but never enabled.
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: false } } });

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);

    const after = await readFile(settingsPath, "utf8");
    assert.equal(after, originalSettings);
  });

});

describe("uninstall (interactive path)", () => {
  // Drive runUninstallCommand in-process with a faked TTY so the interactive
  // (per-harness, non-forced) branch runs. Stub the harness registry so we
  // control each `off` outcome and can assert per-harness data-dir deletion
  // ordering: a dir is removed only after its `off` succeeds; a failed harness
  // keeps its dir so `off` stays recoverable.

  function withFakedTTY(fn) {
    const realStdin = process.stdin;
    const realIsTTY = realStdin.isTTY;
    Object.defineProperty(realStdin, "isTTY", { value: true, configurable: true });
    return Promise.resolve(fn()).finally(() => {
      Object.defineProperty(realStdin, "isTTY", { value: realIsTTY, configurable: true });
    });
  }

  /** Run `fn` with HOME pointed at `home` (runUninstallCommand reads process.env.HOME). */
  function withHome(home, fn) {
    const realHome = process.env.HOME;
    process.env.HOME = home;
    return Promise.resolve(fn()).finally(() => {
      if (realHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = realHome;
      }
    });
  }

  /**
   * Present a harness as routed (or not) and optionally stub its `off`.
   *
   * "On" is resolved from the harness's own config via `providerStatus`, not
   * from Nexus's `enabled` flag, so a test that wants a harness treated
   * as on has to say so here — writing `enabled: true` into the global config
   * is not enough and would silently test nothing.
   *
   * @returns {() => void} restores the adapter
   */
  function stubHarness(id, { routed = true, off } = {}) {
    const adapter = registry.getHarness(id);
    const orig = { off: adapter.off, providerStatus: adapter.providerStatus };
    adapter.providerStatus = async () => (routed ? "fireworks" : "none");
    if (off) {
      adapter.off = off;
    }
    return () => {
      adapter.off = orig.off;
      adapter.providerStatus = orig.providerStatus;
    };
  }

  it("deletes each harness data dir only after its off succeeds", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-interactive-"));
    // Two registered harnesses with on-disk data dirs.
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true }, opencode: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });
    await mkdir(path.join(home, ".nexus/opencode"), { recursive: true });
    await writeFile(path.join(home, ".nexus/claude/marker"), "1");
    await writeFile(path.join(home, ".nexus/opencode/marker"), "1");

    let claudeOffCalls = 0;
    let opencodeOffCalls = 0;
    const restore = [
      stubHarness(HARNESS.CLAUDE, { off: async () => { claudeOffCalls += 1; } }),
      stubHarness(HARNESS.OPENCODE, {
        off: async () => { opencodeOffCalls += 1; throw new Error("boom"); },
      }),
    ];

    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore.forEach((fn) => fn());
    }

    assert.equal(claudeOffCalls, 1, "claude off ran once");
    assert.equal(opencodeOffCalls, 1, "opencode off ran once");
    // Succeeded harness: its data dir was removed right after off succeeded.
    assert.equal(await pathExists(path.join(home, ".nexus/claude/marker")), false,
      "claude data dir removed after successful off");
    // Failed harness: its backup survives. Uninstall stops before the global
    // cleanup precisely so this stays usable for a retry.
    assert.equal(await pathExists(path.join(home, ".nexus/opencode/marker")), true,
      "failed harness keeps its backup");
    assert.notEqual(process.exitCode, 0, "non-zero exit on off failure");
    process.exitCode = origExitCode;
  });

  it("interactive path does not force (lets the IDE guard run)", async () => {
    // The interactive branch passes ctx.force (false) to off, not hardcoded
    // true. Assert by capturing the force flag the adapter's off receives.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-interactive-force-"));
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });

    let capturedForce;
    const restore = stubHarness(HARNESS.CLAUDE, {
      off: async (ctx) => { capturedForce = ctx.force; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
    }
    assert.equal(capturedForce, false, "interactive path must not force");
    process.exitCode = origExitCode;
  });

  it("omits harnesses that are not on from the checklist entirely", async () => {
    // A harness that is not routed has nothing to restore. It must not be
    // listed, and its `off` must not run — every harness in the config used to
    // be listed, so ones that were off rendered as "wasn't connected".
    // Note the config claims opencode is enabled: its real config says
    // otherwise, and the harness's own config wins.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-onlyon-"));
    await writeGlobalConfig(home, {
      harnesses: { claude: { enabled: true }, opencode: { enabled: true } },
    });
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });

    const ran = [];
    const restore = [
      stubHarness(HARNESS.CLAUDE, {
        routed: true,
        off: async () => { ran.push("claude"); return "restored"; },
      }),
      stubHarness(HARNESS.OPENCODE, {
        routed: false,
        off: async () => { ran.push("opencode"); return "restored"; },
      }),
    ];

    let out = "";
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { out += String(chunk); return true; };
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      process.stdout.write = realWrite;
      restore.forEach((fn) => fn());
      process.exitCode = origExitCode;
    }

    assert.deepEqual(ran, ["claude"], "only the routed harness runs off");
    assert.match(out, /Claude Code/);
    assert.doesNotMatch(out, /OpenCode/, "an unrouted harness must not be listed");
    assert.doesNotMatch(out, /wasn't connected/, "no not-connected noise");
  });

  it("restores a harness that is routed but missing from config", async () => {
    // Regression: discovery used to read only config.harnesses, so a lost or
    // reinstalled ~/.nexus meant no `off` ran at all — uninstall deleted
    // the backup while leaving the harness pointed at Fireworks with its
    // built-in models hidden, which is unrecoverable. providerStatus reads the
    // harness's real config, so it catches what the config map misses.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-orphan-"));
    // No config.json at all — just an installed CLI.
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });

    let offRan = false;
    const restore = stubHarness(HARNESS.CURSOR, {
      routed: true,
      off: async () => { offRan = true; return "stripped"; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
      process.exitCode = origExitCode;
    }
    assert.equal(offRan, true, "a routed harness must be restored even without a config entry");
  });

  it("does not restore harnesses that are not routed", async () => {
    // The discovery probe must not drag in every harness — only routed ones.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-notrouted-"));
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });

    let offRan = false;
    const restore = stubHarness(HARNESS.CURSOR, {
      routed: false,
      off: async () => { offRan = true; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
      process.exitCode = origExitCode;
    }
    assert.equal(offRan, false, "an unrouted harness must be left alone");
  });

  it("aborts before cleanup when a restore fails, keeping FireConnect usable", async () => {
    // Regression: a failed `off` leaves that harness routed through Fireworks,
    // and its backup is the only way back. Uninstall must not remove the
    // backup, the config, or the CLI needed to retry. The likely trigger is
    // the user declining to quit Cursor — deleting their backup in response
    // would be indefensible.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-abort-"));
    await writeGlobalConfig(home, { harnesses: { cursor: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/cursor"), { recursive: true });
    await writeFile(path.join(home, ".nexus/cursor/cursor-backup.json"), '{"snapshot":{}}');
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });
    await mkdir(path.join(home, ".local/bin"), { recursive: true });
    await writeFile(path.join(home, ".local/bin/nexus"), "exec node /cli/packages/setup-cli/bin/nexus.mjs \"$@\"\n");

    const restore = stubHarness(HARNESS.CURSOR, {
      off: async () => { throw new Error("Cursor is running."); },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
    }

    assert.notEqual(process.exitCode, 0, "exits non-zero");
    process.exitCode = origExitCode;
    assert.equal(await pathExists(path.join(home, ".nexus/cursor/cursor-backup.json")), true,
      "backup preserved for retry");
    assert.equal(await pathExists(path.join(home, ".nexus/cli")), true,
      "CLI preserved so the retry is runnable");
    assert.equal(await pathExists(path.join(home, ".local/bin/nexus")), true,
      "launcher preserved so the retry is runnable");
    assert.equal(await pathExists(globalConfigPath(home)), true, "config preserved");
  });

  it("passes quiet to off so harness narration does not fight the checklist", async () => {
    // Regression: engineOff (and claude's own off) print restored/restart lines
    // to stdout during the off call. Uninstall prints its own checklist and a
    // single restart reminder, so it must silence them.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-quiet-"));
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });

    let capturedQuiet;
    const restore = stubHarness(HARNESS.CLAUDE, {
      off: async (ctx) => { capturedQuiet = ctx.quiet; return "restored"; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
      process.exitCode = origExitCode;
    }
    assert.equal(capturedQuiet, true, "interactive uninstall must pass quiet");
  });

  it("reports the real off outcome in the checklist", async () => {
    // A harness that was never connected must not be reported as "restored".
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-outcome-"));
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });

    // Routed, so it is listed — but `off` finds nothing to undo (state drift).
    const restore = stubHarness(HARNESS.CLAUDE, { off: async () => "none" });
    let out = "";
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { out += String(chunk); return true; };
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      process.stdout.write = realWrite;
      restore();
      process.exitCode = origExitCode;
    }
    assert.match(out, /wasn't connected/, "outcome 'none' must not claim a restore");
    assert.doesNotMatch(out, /Your original settings are back/,
      "nothing was restored, so the farewell must not claim otherwise");
  });

  it("still removes files when no harnesses are registered (installed CLI only)", async () => {
    // Regression: an install with no `fci <harness> on` yet has an empty
    // harnesses map but Nexus files on disk. Uninstall must remove the
    // files, not bail out with "Nexus is not installed."
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-no-harnesses-"));
    // No global config / no harnesses — but the CLI launcher + ~/.nexus exist.
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });
    await writeFile(path.join(home, ".nexus/cli/marker"), "1");
    await mkdir(path.join(home, ".local/bin"), { recursive: true });
    await writeFile(path.join(home, ".local/bin/nexus"), "exec node /cli/packages/setup-cli/bin/nexus.mjs \"$@\"\n");

    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      process.exitCode = origExitCode;
    }
    assert.equal(await pathExists(path.join(home, ".nexus")), false,
      "~/.nexus removed even with no harnesses");
    assert.equal(await pathExists(path.join(home, ".local/bin/nexus")), false,
      "launcher removed even with no harnesses");
  });

  it("says 'not installed' only when there are no harnesses and no files", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-truly-absent-"));
    // Nothing on disk, no config.
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    let stdout = "";
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      process.stdout.write = realWrite;
      process.exitCode = origExitCode;
    }
    assert.match(stdout, /Nexus CLI is not installed\./);
  });

  it("non-interactive --force path still forces every off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-force-flag-"));
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });

    let capturedForce;
    const restore = stubHarness(HARNESS.CLAUDE, {
      off: async (ctx) => { capturedForce = ctx.force; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      // --force → ctx.force true → non-interactive branch forces.
      await withHome(home, () => runUninstallCommand({ force: true }));
    } finally {
      restore();
    }
    assert.equal(capturedForce, true, "--force forces every off");
    process.exitCode = origExitCode;
  });

});

describe("uninstall launchers", () => {
  it("removes the launchers it installed under either name but not another tool's", async () => {
    for (const [content, kept] of [
      ["exec node /cli/packages/setup-cli/bin/nexus.mjs \"$@\"\n", false],
      ["#!/bin/sh\nexec other-tool \"$@\"\n", true],
    ]) {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-"));
      const bin = path.join(home, ".local/bin");
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, "fireconnect"), "exec node /cli/packages/setup-cli/bin/fireconnect.mjs \"$@\"\n");
      await writeFile(path.join(bin, "nexus"), content);

      const result = await runFireconnect(["uninstall"], { HOME: home });
      assert.equal(result.code, 0);
      assert.equal(await pathExists(path.join(bin, "fireconnect")), false);
      assert.equal(await pathExists(path.join(bin, "nexus")), kept);
    }
  });
});

describe("uninstall data directories", () => {
  it("removes ~/.nexus and an unfinished move's ~/.fireconnect", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-deferred-"));
    await mkdir(path.join(home, ".fireconnect"), { recursive: true });
    await writeFile(path.join(home, ".fireconnect/update-check.json"), "{}");
    await symlink(".fireconnect", path.join(home, ".nexus"), "dir");

    const result = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(result.code, 0);
    await assert.rejects(lstat(path.join(home, ".nexus")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(home, ".fireconnect")), { code: "ENOENT" });
  });
});

describe("legacy data directory next to an existing ~/.nexus", () => {
  it("merges the old backups in, so off and uninstall work", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-merge-"));
    await mkdir(path.join(home, ".fireconnect/claude"), { recursive: true });
    await writeFile(path.join(home, ".fireconnect/claude/settings.backup.json"), "{}");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    for (const args of [["claude", "off"], ["uninstall"]]) {
      const result = await runFireconnect(args, { HOME: home });
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
    }
    assert.equal(await pathExists(path.join(home, ".nexus")), false);
    assert.equal(await pathExists(path.join(home, ".fireconnect")), false);
  });
  it("removes a kept ~/.nexus-pre, and only the link when it points into dotfiles", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-pre-"));
    await mkdir(path.join(home, "dotfiles/fireconnect"), { recursive: true });
    await writeFile(path.join(home, "dotfiles/fireconnect/config.json"), "{}");
    await symlink(path.join(home, "dotfiles/fireconnect"), path.join(home, ".fireconnect"), "dir");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await pathExists(path.join(home, ".nexus-pre")), false);
    assert.equal(await pathExists(path.join(home, ".fireconnect")), false);
    assert.equal(await readFile(path.join(home, "dotfiles/fireconnect/config.json"), "utf8"), "{}");
  });
});

