import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { globalConfigPath, setHarnessEnabled } from "../../lib/config/global-config.mjs";
import { codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { runCli, withTempHome } from "../helpers.mjs";

/**
 * Child env whose PATH is one empty dir under `home`, so the host's own
 * installs never decide the outcome. The CLI runs via process.execPath, so
 * it needs nothing on PATH.
 */
async function gateEnv(home) {
  const bin = path.join(home, "bin");
  await mkdir(bin, { recursive: true });
  return { bin, env: { FIREWORKS_API_KEY: "fw_test_key_12345", PATH: bin } };
}

async function installFakeCommand(bin, name) {
  const file = path.join(bin, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
}

describe("harness install gate", () => {
  it("refuses `on` when the harness's command isn't on PATH, and writes nothing", async () => {
    await withTempHome("install-gate-missing-", async (home) => {
      const { env } = await gateEnv(home);
      const result = await runCli(["pi", "on"], { home, env, installGate: true });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Pi isn't installed \(looked for the `pi` command or Pi's session history\)/);
      assert.match(result.stderr, /--skip-install-check/);
      assert.equal(existsSync(path.join(home, ".pi")), false);
      assert.equal(existsSync(globalConfigPath(home)), false);
    });
  });

  it("ignores a config folder left behind without the tool", async () => {
    await withTempHome("install-gate-leftover-", async (home) => {
      const { env } = await gateEnv(home);
      await mkdir(path.join(home, ".dsh"), { recursive: true });
      const result = await runCli(["deepseek", "on"], { home, env, installGate: true });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /isn't installed \(looked for the `dsh` command or DeepSeek Harness's profiles\)/);
    });
  });

  it("refuses the bare `nexus <harness>` form too", async () => {
    await withTempHome("install-gate-bare-", async (home) => {
      const { env } = await gateEnv(home);
      const result = await runCli(["pi"], { home, env, installGate: true });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /isn't installed/);
    });
  });

  it("still refuses when only --data-dir is passed", async () => {
    await withTempHome("install-gate-data-dir-", async (home) => {
      const { env } = await gateEnv(home);
      const dataDir = path.join(home, "nexus-data");
      const result = await runCli(["pi", "on", "--data-dir", dataDir], { home, env, installGate: true });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /isn't installed/);
    });
  });

  it("allows `on` once the command is on PATH", async () => {
    await withTempHome("install-gate-present-", async (home) => {
      const { bin, env } = await gateEnv(home);
      await installFakeCommand(bin, "pi");
      const result = await runCli(["pi", "on"], { home, env, installGate: true });
      assert.equal(result.code, 0, result.stderr);
    });
  });

  it("skips the check when a path flag points at the harness's config", async () => {
    await withTempHome("install-gate-path-", async (home) => {
      const { env } = await gateEnv(home);
      const configPath = path.join(home, "elsewhere", "config.toml");
      const result = await runCli(["codex", "on", "--config-path", configPath], { home, env, installGate: true });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(existsSync(configPath), true);
    });
  });

  it("--skip-install-check overrides a false negative", async () => {
    await withTempHome("install-gate-skip-", async (home) => {
      const { env } = await gateEnv(home);
      const result = await runCli(["pi", "on", "--skip-install-check"], { home, env, installGate: true });
      assert.equal(result.code, 0, result.stderr);
    });
  });

  it("re-applies a harness Nexus already enabled", async () => {
    await withTempHome("install-gate-enabled-", async (home) => {
      const { env } = await gateEnv(home);
      await setHarnessEnabled(home, "pi", true);
      const result = await runCli(["pi", "on"], { home, env, installGate: true });
      assert.equal(result.code, 0, result.stderr);
    });
  });

  it("never gates off or status", async () => {
    await withTempHome("install-gate-off-", async (home) => {
      const { env } = await gateEnv(home);
      for (const verb of ["off", "status"]) {
        const result = await runCli(["pi", verb], { home, env, installGate: true });
        assert.doesNotMatch(result.stderr, /isn't installed/, verb);
      }
    });
  });

  it("writes Codex's config once the check passes", async () => {
    await withTempHome("install-gate-codex-", async (home) => {
      const { bin, env } = await gateEnv(home);
      await installFakeCommand(bin, "codex");
      const result = await runCli(["codex", "on"], { home, env, installGate: true });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(existsSync(codexConfigPath(home)), true);
    });
  });
});
