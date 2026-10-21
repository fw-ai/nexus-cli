import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  FIREWORKS_API_KEY_ENV_REF,
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  writeGlobalConfig,
} from "../../lib/config/global-config.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piAuthPath } from "../../lib/harnesses/pi/core.mjs";
import { runCli, runFireconnect, seedKeychainConfig, withTempHome } from "../helpers.mjs";

const KEY = "fw_cli_literal_bake_key_000000000000";

function startMockGateway() {
  const server = createServer((req, res) => {
    if (req.url !== "/verifyApiKey") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "x-fireworks-developer-email": "dev@example.com",
      "x-fireworks-account-id": "acct-test",
    });
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function readShellHook(home) {
  try {
    return await readFile(path.join(home, ".zshrc"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

describe("literal-bake CLI flows", () => {
  let gateway;
  let gatewayEnv;

  before(async () => {
    gateway = await startMockGateway();
    gatewayEnv = { NEXUS_GATEWAY_URL: gateway.url };
  });

  after(() => {
    gateway.server.close();
  });

  it("login then opencode on bakes a literal and skips FIREWORKS shell export", async () => {
    await withTempHome("cli-login-oc-", async (home) => {
      process.env.SHELL = "/bin/zsh";
      await mkdir(path.dirname(opencodeConfigPath(home, "")), { recursive: true });

      const login = await runCli(["login", "--api-key", KEY], { home, env: gatewayEnv });
      assert.equal(login.code, 0, login.stderr);

      const on = await runFireconnect(["opencode", "on"], { HOME: home, FIREWORKS_API_KEY: "", ...gatewayEnv });
      assert.equal(on.code, 0, on.stderr);
      assert.doesNotMatch(on.stderr, /reads FIREWORKS_API_KEY from the environment via a shell hook/);

      const config = JSON.parse(await readFile(opencodeConfigPath(home, ""), "utf8"));
      assert.equal(config.provider["fireworks-ai"].options.apiKey, KEY);
      assert.doesNotMatch(await readShellHook(home), /export FIREWORKS_API_KEY=/);
    });
  });

  it("pi on bakes literal from keychain without shell-hook warning", async () => {
    await withTempHome("cli-pi-on-", async (home) => {
      process.env.SHELL = "/bin/zsh";
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await seedKeychainConfig(home, KEY);

      const on = await runFireconnect(["pi", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(on.code, 0, on.stderr);
      assert.doesNotMatch(on.stderr, /reads FIREWORKS_API_KEY from the environment via a shell hook/);

      const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
      assert.equal(auth.fireworks.key, KEY);
      assert.doesNotMatch(await readShellHook(home), /export FIREWORKS_API_KEY=/);
    });
  });

  it("pi on repairs legacy global env-ref when keychain holds the secret", async () => {
    await withTempHome("cli-pi-repair-", async (home) => {
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await seedKeychainConfig(home, KEY);
      await writeGlobalConfig(home, { apiKey: FIREWORKS_API_KEY_ENV_REF });

      const on = await runFireconnect(["pi", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(on.code, 0, on.stderr);

      const config = await readGlobalConfig(home);
      assert.equal(config.apiKey, FIREWORKS_API_KEY_KEYCHAIN_REF);
      assert.equal(JSON.parse(await readFile(piAuthPath(home), "utf8")).fireworks.key, KEY);
    });
  });

  it("reconcileHarnessConfigOnUpgrade rebakes legacy env-ref via upgrade finalize path", async () => {
    await withTempHome("cli-upgrade-rebake-", async (home) => {
      process.env.SHELL = "/bin/zsh";
      await seedKeychainConfig(home, KEY);
      await writeGlobalConfig(home, {
        apiKey: FIREWORKS_API_KEY_ENV_REF,
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      await mkdir(path.dirname(opencodeConfigPath(home, "")), { recursive: true });
      await writeFile(
        opencodeConfigPath(home, ""),
        `${JSON.stringify({
          model: "fireworks-ai/accounts/fireworks/models/glm-4p6",
          provider: {
            "fireworks-ai": {
              options: { apiKey: FIREWORKS_API_KEY_ENV_REF },
              models: {},
            },
          },
        }, null, 2)}\n`,
      );
      await writeFile(
        path.join(home, ".zshrc"),
        [
          "# >>> fireconnect >>>",
          'export FIREWORKS_API_KEY="$(fireconnect key export 2>/dev/null)"',
          "# <<< fireconnect <<<",
          "",
        ].join("\n"),
      );

      const { reconcileHarnessConfigOnUpgrade } = await import("../../lib/keys/sync.mjs");
      const notes = await reconcileHarnessConfigOnUpgrade(home);
      assert.equal(notes.length, 1, notes.join("\n"));

      const opencode = JSON.parse(await readFile(opencodeConfigPath(home, ""), "utf8"));
      assert.equal(opencode.provider["fireworks-ai"].options.apiKey, KEY);
      assert.equal((await readGlobalConfig(home)).apiKey, FIREWORKS_API_KEY_KEYCHAIN_REF);
      assert.doesNotMatch(await readShellHook(home), /export FIREWORKS_API_KEY=/);
    });
  });
});
