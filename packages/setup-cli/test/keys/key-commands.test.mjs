import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FIREWORKS_API_KEY_KEYCHAIN_REF, readGlobalConfig, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { chatLanguageModelsPath } from "../../lib/harnesses/vscode/core.mjs";
import { runFireconnect, runCli, seedKeychainConfig, withTempHome } from "../helpers.mjs";

const FW_KEY = "fw_test_fireworks_key_00000000000000";
// Plaintext secret seam keeps VS Code storage deterministic and headless.
const vscodeRouterEnv = () => ({
  NEXUS_VSCODE_SECRET_PLAINTEXT: "1",
  // `status` live-verifies the active key; point at an unreachable gateway so
  // these storage/per-harness assertions stay offline and deterministic.
  NEXUS_GATEWAY_URL: "http://127.0.0.1:1",
});

describe("fireconnect key", () => {
  it("export prints the stored keychain secret (internal apiKeyHelper/shell-hook resolver)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-key-export-"));
    await seedKeychainConfig(home, "fw_export_test_key");

    const result = await runFireconnect(["key", "export"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "fw_export_test_key");
  });

  it("status reports keychain-backed config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-key-status-"));
    await seedKeychainConfig(home, "fw_status_test_key");

    const result = await runFireconnect(["status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
      // Offline verify: a stored key is present, so status exits 0 once the
      // (unreachable) gateway check comes back as "couldn't verify".
      NEXUS_GATEWAY_URL: "http://127.0.0.1:1",
    });
    assert.equal(result.code, 0);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.configRef, FIREWORKS_API_KEY_KEYCHAIN_REF);
    assert.equal(summary.keychainPresent, true);
  });

  it("status reports encrypted safeStorage for vscode in direct mode", async () => {
    await withTempHome("fc-key-status-vscode-direct-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      // `on --api-key` strict-verifies the key, so drop the unreachable-gateway
      // override here (inherit the test double from global-setup); `status`
      // below keeps it to stay offline for the verify it does.
      const { NEXUS_GATEWAY_URL: _drop, ...onEnv } = vscodeRouterEnv();
      const on = await runCli(
        ["vscode", "on", "--api-key", FW_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: onEnv },
      );
      assert.equal(on.code, 0, `stderr: ${on.stderr}`);

      const status = await runCli(["status", "--json"], { home, env: vscodeRouterEnv() });
      const vscode = JSON.parse(status.stdout).perHarness.find((h) => h.id === "vscode");
      assert.match(vscode.storage, /safeStorage \(encrypted\)/);
      assert.doesNotMatch(vscode.storage, /PLAINTEXT/);
    });
  });
});
