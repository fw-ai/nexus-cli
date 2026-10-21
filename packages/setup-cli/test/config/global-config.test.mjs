import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readGlobalConfig,
  writeGlobalConfig,
  resolveStoredApiKey,
  discoverHarnessesForUninstall,
  setHarnessEnabled,
  setHarnessState,
  listRegisteredHarnesses,
  listEnabledHarnesses,
  FIREWORKS_API_KEY_ENV_REF,
  globalConfigPath,
} from "../../lib/config/global-config.mjs";
import { writeJson } from "../../lib/io/json.mjs";

process.env.NEXUS_SECRET_STORE ??= "memory";
process.env.NEXUS_TEST ??= "1";

describe("global-config", () => {
  it("reads empty apiKey when config file is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-config-missing-"));
    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, "");
    assert.equal(config._exists, false);
  });

  it("writes and reads config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-config-"));
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_ENV_REF,
      harnesses: {
        claude: { enabled: false },
        opencode: { enabled: false },
      },
    });

    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, FIREWORKS_API_KEY_ENV_REF);
    assert.deepEqual(listRegisteredHarnesses(config.harnesses), ["claude", "opencode"]);
    assert.deepEqual(listEnabledHarnesses(config.harnesses), []);
  });

  it("resolveStoredApiKey reads env ref", () => {
    const previous = process.env.FIREWORKS_API_KEY;
    process.env.FIREWORKS_API_KEY = "fw_test_key";
    assert.equal(resolveStoredApiKey(FIREWORKS_API_KEY_ENV_REF), "fw_test_key");
    process.env.FIREWORKS_API_KEY = previous;
  });

  it("discoverHarnessesForUninstall returns all registered harnesses including disabled ones", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-discover-"));
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_ENV_REF,
      harnesses: {
        claude: { enabled: true },
        opencode: { enabled: false },
      },
    });

    const ids = await discoverHarnessesForUninstall(home);
    assert.deepEqual(ids, ["claude", "opencode"]);
  });

  it("setHarnessEnabled updates config without dropping other harnesses", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-set-enabled-"));
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_ENV_REF,
      harnesses: {
        claude: { enabled: false },
        opencode: { enabled: false },
      },
    });

    await setHarnessEnabled(home, "claude", true);

    const config = await readGlobalConfig(home);
    assert.equal(config.harnesses.claude.enabled, true);
    assert.equal(config.harnesses.opencode.enabled, false);
  });

  it("readGlobalConfig drops retired/unknown harness ids (e.g. deepagents)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-roster-normalize-"));
    // A legacy config carries a retired id (`deepagents`) alongside a current
    // one; normalizeHarnessMap must keep the current roster and drop the rest.
    await writeJson(globalConfigPath(home), {
      apiKey: FIREWORKS_API_KEY_ENV_REF,
      harnesses: {
        claude: { enabled: true, provider: "fireworks" },
        deepagents: { enabled: true, provider: "fireworks" },
      },
    });

    const config = await readGlobalConfig(home);
    assert.equal(config.harnesses.claude?.enabled, true);
    assert.equal(config.harnesses.deepagents, undefined, "retired id should be dropped");
    assert.deepEqual(Object.keys(config.harnesses), ["claude"]);
  });

  it("setHarnessEnabled changes only harness state", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-legacy-migrate-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const legacyKey = "fw_legacy_global_key_12345";
    try {
      await writeJson(globalConfigPath(home), {
        apiKey: legacyKey,
        harnesses: { claude: { enabled: true } },
      });

      await setHarnessEnabled(home, "claude", false);

      const config = await readGlobalConfig(home);
      assert.equal(config.apiKey, legacyKey);
      assert.equal(config.harnesses.claude.enabled, false);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  it("atomically stores and preserves key-scoped profiles across toggles", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-model-preferences-"));
    const profiles = {
      fireworks: {
        version: 1,
        models: {
          main: "glm-latest",
          opus: "glm-fast-latest",
          sonnet: "glm-fast-latest",
          haiku: "deepseek-v4-flash",
          fable: "kimi-fast-latest",
          subagent: "deepseek-v4-flash",
        },
      },
    };

    await setHarnessState(home, "claude", {
      enabled: true,
      provider: "fireworks",
      profiles,
    });
    await setHarnessEnabled(home, "claude", false);

    const config = await readGlobalConfig(home);
    assert.deepEqual(config.harnesses.claude.profiles, profiles);
    assert.equal(config.harnesses.claude.enabled, false);
    assert.equal(config.harnesses.claude.provider, "fireworks");
  });
});
