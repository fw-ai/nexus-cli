import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { HARNESSES } from "../../lib/harness/id.mjs";
import { checkHarnessInstall } from "../../lib/harness/detect.mjs";
import { runCli, withTempHome } from "../helpers.mjs";

// File-config harnesses whose `on` succeeds in a bare test home on every
// platform; for these a failed run would make the check vacuous. Desktop
// harnesses may refuse without their app, keychain, or a stored key, and are
// still checked for whatever they wrote before refusing.
const MUST_SUCCEED = new Set(["claude", "opencode", "codex", "pi", "copilot-cli", "deepseek"]);

/**
 * The install gate only works if Nexus never writes the files that count as
 * installed. Run every harness's `on` in an empty home with nothing on PATH
 * and assert the harness still reads as not installed afterwards, so a change
 * that starts writing one of those paths fails here instead of quietly
 * turning the gate into a no-op.
 */
describe("Nexus never writes a harness's install signals", () => {
  for (const harness of HARNESSES) {
    it(`${harness} on leaves ${harness} not installed`, async () => {
      await withTempHome(`install-signals-${harness}-`, async (home) => {
        const bin = path.join(home, "bin");
        const root = path.join(home, "root");
        await mkdir(bin, { recursive: true });
        // Pin every location the harness or the check derives from env, so
        // the run writes only under this home.
        const env = {
          PATH: bin,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
          FIREWORKS_API_KEY: "fw_test_key_12345",
        };
        const result = await runCli([harness, "on", "--skip-install-check"], { home, env, installGate: true });
        if (MUST_SUCCEED.has(harness)) {
          assert.equal(result.code, 0, result.stderr);
        }
        const { state } = checkHarnessInstall(home, harness, { env, platform: process.platform, root });
        assert.notEqual(state, "installed", `${harness} on wrote a file that counts as ${harness} being installed`);
      });
    });
  }
});
