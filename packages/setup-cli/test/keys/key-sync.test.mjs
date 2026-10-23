import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { syncBakedKeysAfterStore } from "../../lib/keys/sync.mjs";
import { piAuthPath } from "../../lib/harnesses/pi/core.mjs";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import {
  addFireworksProvider,
  buildAzureModelEntry,
  buildModelEntry,
  chatLanguageModelsPath,
  isVscodeRunning,
  makeFireconnectSecretId,
  refreshVscodeGatewayKey,
  vscodeStateDbPath,
  writeChatLanguageModels,
} from "../../lib/harnesses/vscode/core.mjs";
import { aesEncrypt, linuxSecretServiceReachable } from "../../lib/harnesses/vscode/safestorage.mjs";
import {
  ensureItemTable,
  readItemTableValue,
  writeItemTableValue,
} from "../../lib/harnesses/vscode/vscdb-sqlite.mjs";
import { itIfSqlite, runCli, withTempHome } from "../helpers.mjs";

const NEW_KEY = "fw_fresh_key_000000000000000000000";

async function enableHarnessesForSync(home, ids) {
  await writeGlobalConfig(home, {
    harnesses: Object.fromEntries(ids.map((id) => [id, { enabled: true, provider: "fireworks" }])),
  });
}

function startMockGatewayForKey(key) {
  const server = createServer((req, res) => {
    if (req.url !== "/verifyApiKey") {
      res.writeHead(404);
      res.end();
      return;
    }
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (auth === key) {
      res.writeHead(200, {
        "x-fireworks-developer-email": "dev@example.com",
        "x-fireworks-account-id": "acct-test",
      });
    } else {
      res.writeHead(401);
    }
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function writeJsonFile(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

describe("syncBakedKeysAfterStore", () => {
  it("re-bakes Claude's custom header", async () => {
    await withTempHome("key-sync-", async (home) => {
      await enableHarnessesForSync(home, ["claude"]);
      await writeJsonFile(userSettingsPath(home), {
        env: {
          ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_stale\nx-routing-preference: 3",
        },
      });

      const notes = await syncBakedKeysAfterStore(home, NEW_KEY);
      assert.equal(notes.length, 1, notes.join("\n"));
      assert.match(notes[0], /Claude Code/);

      const claude = await readJson(userSettingsPath(home));
      assert.equal(
        claude.env.ANTHROPIC_CUSTOM_HEADERS,
        `X-Fireworks-Api-Key: ${NEW_KEY}\nx-routing-preference: 3`,
      );

      // Second run: everything matches — no rewrites, no notes.
      assert.deepEqual(await syncBakedKeysAfterStore(home, NEW_KEY), []);
    });
  });

  it("re-bakes the gateway literal key for OpenCode (fireworks-ai) and Pi (auth.json)", async () => {
    await withTempHome("key-sync-gateway-", async (home) => {
      await enableHarnessesForSync(home, ["opencode", "pi"]);
      // Direct/firerouter gateway configs store the Fireworks key as a plaintext
      // literal, not a legacy header. A login must refresh those too.
      await writeJsonFile(opencodeConfigPath(home, ""), {
        provider: {
          "fireworks-ai": {
            options: { baseURL: "https://api.fireworks.ai/inference/v1", apiKey: "fw_stale_gateway_00000000000000000" },
            models: { "fireworks-ai/accounts/fireworks/models/glm-4p6": { name: "glm" } },
          },
        },
      });
      await writeJsonFile(piAuthPath(home), {
        fireworks: { type: "api_key", key: "fw_stale_gateway_00000000000000000", managedBy: "fireconnect" },
        other: { type: "api_key", key: "user-owned" }, // unmanaged — untouched
      });

      const notes = await syncBakedKeysAfterStore(home, NEW_KEY);
      assert.equal(notes.filter((n) => /Pi|OpenCode/.test(n)).length, 2, notes.join("\n"));

      const opencode = await readJson(opencodeConfigPath(home, ""));
      assert.equal(opencode.provider["fireworks-ai"].options.apiKey, NEW_KEY);
      assert.equal(opencode.provider["fireworks-ai"].options.baseURL, "https://api.fireworks.ai/inference/v1");

      const auth = await readJson(piAuthPath(home));
      assert.equal(auth.fireworks.key, NEW_KEY);
      assert.equal(auth.fireworks.managedBy, "fireconnect");
      assert.equal(auth.other.key, "user-owned");

      // Idempotent: nothing to change on a second run.
      assert.deepEqual(await syncBakedKeysAfterStore(home, NEW_KEY), []);
    });
  });

  it("skips harnesses that are disabled in global config", async () => {
    await withTempHome("key-sync-disabled-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: {
          opencode: { enabled: false, provider: "fireworks" },
          pi: { enabled: true, provider: "fireworks" },
        },
      });
      await writeJsonFile(opencodeConfigPath(home, ""), {
        provider: {
          "fireworks-ai": {
            options: { apiKey: "fw_stale_gateway_00000000000000000" },
            models: {},
          },
        },
      });
      await writeJsonFile(piAuthPath(home), {
        fireworks: { type: "api_key", key: "fw_stale_gateway_00000000000000000", managedBy: "fireconnect" },
      });

      const notes = await syncBakedKeysAfterStore(home, NEW_KEY);
      assert.equal(notes.length, 1);
      assert.match(notes[0], /Pi/);

      const opencode = await readJson(opencodeConfigPath(home, ""));
      assert.equal(opencode.provider["fireworks-ai"].options.apiKey, "fw_stale_gateway_00000000000000000");
      const auth = await readJson(piAuthPath(home));
      assert.equal(auth.fireworks.key, NEW_KEY);
    });
  });

  it("re-bakes legacy env-reference gateway keys to literals on login sync", async () => {
    await withTempHome("key-sync-envref-", async (home) => {
      await enableHarnessesForSync(home, ["opencode", "pi"]);
      await writeJsonFile(opencodeConfigPath(home, ""), {
        provider: { "fireworks-ai": { options: { apiKey: "{env:FIREWORKS_API_KEY}" }, models: {} } },
      });
      await writeJsonFile(piAuthPath(home), {
        fireworks: { type: "api_key", key: "$FIREWORKS_API_KEY", managedBy: "fireconnect" },
      });

      const notes = await syncBakedKeysAfterStore(home, NEW_KEY);
      assert.equal(notes.filter((n) => /Pi|OpenCode/.test(n)).length, 2, notes.join("\n"));
      assert.equal(
        (await readJson(opencodeConfigPath(home, ""))).provider["fireworks-ai"].options.apiKey,
        NEW_KEY,
      );
      assert.equal((await readJson(piAuthPath(home))).fireworks.key, NEW_KEY);
    });
  });

  itIfSqlite("re-keys VS Code's secret storage and leaves an Azure provider alone", { skip: isVscodeRunning() && "VS Code is running" }, async () => {
    const saved = {
      plaintext: process.env.NEXUS_VSCODE_SECRET_PLAINTEXT,
      xdg: process.env.XDG_CONFIG_HOME,
    };
    process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = "1";
    delete process.env.XDG_CONFIG_HOME;
    try {
      await withTempHome("key-sync-vscode-", async (home) => {
        await enableHarnessesForSync(home, ["vscode"]);
        const vscodePath = chatLanguageModelsPath({ home });
        const stateDbPath = vscodeStateDbPath({ vscodePath });
        const secretId = makeFireconnectSecretId();
        const writeProvider = (models) => writeChatLanguageModels(
          vscodePath,
          addFireworksProvider([], { secretId, models }),
        );
        await ensureItemTable(stateDbPath);
        await writeItemTableValue(stateDbPath, `secret://${secretId}`, "fw_stale_gateway_00000000000000000");
        await writeProvider([buildModelEntry("accounts/fireworks/models/test-model")]);
        assert.equal((await stat(vscodePath)).mode & 0o077, 0, "key-bearing VS Code config is owner-only");

        const notes = await syncBakedKeysAfterStore(home, NEW_KEY);
        assert.equal(notes.length, 1, notes.join("\n"));
        assert.match(notes[0], /VS Code/);
        assert.equal(await readItemTableValue(stateDbPath, `secret://${secretId}`), NEW_KEY);
        assert.deepEqual(await syncBakedKeysAfterStore(home, NEW_KEY), []);

        await writeItemTableValue(stateDbPath, `secret://${secretId}`, "azure-key");
        await writeProvider([buildAzureModelEntry("my-deployment", "https://example.openai.azure.com/openai/v1")]);
        assert.deepEqual(await syncBakedKeysAfterStore(home, NEW_KEY), []);
        assert.equal(await readItemTableValue(stateDbPath, `secret://${secretId}`), "azure-key");
      });
    } finally {
      for (const [name, value] of [["NEXUS_VSCODE_SECRET_PLAINTEXT", saved.plaintext], ["XDG_CONFIG_HOME", saved.xdg]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  itIfSqlite("leaves an undecryptable keyring-encrypted VS Code secret untouched", {
    skip: (process.platform !== "linux" && "Linux safeStorage only")
      || (linuxSecretServiceReachable() && "a Secret Service could decrypt the probe")
      || (isVscodeRunning() && "VS Code is running"),
  }, async () => {
    const saved = {
      plaintext: process.env.NEXUS_VSCODE_SECRET_PLAINTEXT,
      xdg: process.env.XDG_CONFIG_HOME,
    };
    delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    delete process.env.XDG_CONFIG_HOME;
    try {
      await withTempHome("key-sync-vscode-keyring-", async (home) => {
        await enableHarnessesForSync(home, ["vscode"]);
        const vscodePath = chatLanguageModelsPath({ home });
        const stateDbPath = vscodeStateDbPath({ vscodePath });
        const secretId = makeFireconnectSecretId();
        const keyringBlob = JSON.stringify(aesEncrypt("fw_keyring_key_0000000000000000000", "keyring-only-pw", "v11", 1));
        await ensureItemTable(stateDbPath);
        await writeItemTableValue(stateDbPath, `secret://${secretId}`, keyringBlob);
        await writeChatLanguageModels(
          vscodePath,
          addFireworksProvider([], { secretId, models: [buildModelEntry("accounts/fireworks/models/test-model")] }),
        );

        await assert.rejects(
          refreshVscodeGatewayKey({ vscodePath, stateDbPath, fireworksKey: NEW_KEY }),
          /could not decrypt/i,
        );
        const notes = await syncBakedKeysAfterStore(home, NEW_KEY);
        assert.equal(notes.length, 1, notes.join("\n"));
        assert.match(notes[0], /Couldn't update VS Code/);
        assert.equal(await readItemTableValue(stateDbPath, `secret://${secretId}`), keyringBlob);
      });
    } finally {
      for (const [name, value] of [["NEXUS_VSCODE_SECRET_PLAINTEXT", saved.plaintext], ["XDG_CONFIG_HOME", saved.xdg]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("login propagates a stored key to other enabled harness baked configs", async () => {
    const { server, url } = await startMockGatewayForKey(NEW_KEY);
    try {
      await withTempHome("key-sync-login-", async (home) => {
        await mkdir(path.join(home, ".nexus"), { recursive: true });
        await enableHarnessesForSync(home, ["pi"]);
        await writeJsonFile(piAuthPath(home), {
          fireworks: { type: "api_key", key: "fw_stale_gateway_00000000000000000", managedBy: "fireconnect" },
        });

        const result = await runCli(["login", "--api-key", NEW_KEY], {
          home,
          env: { NEXUS_GATEWAY_URL: url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Updated Pi's Fireworks settings/);

        const auth = await readJson(piAuthPath(home));
        assert.equal(auth.fireworks.key, NEW_KEY);
      });
    } finally {
      server.close();
    }
  });

  it("syncs harnesses with legacy enabled entries that omit provider", async () => {
    await withTempHome("key-sync-legacy-enabled-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { pi: { enabled: true } },
      });
      await writeJsonFile(piAuthPath(home), {
        fireworks: { type: "api_key", key: "fw_stale_gateway_00000000000000000", managedBy: "fireconnect" },
      });

      const notes = await syncBakedKeysAfterStore(home, NEW_KEY);
      assert.equal(notes.length, 1);
      assert.match(notes[0], /Pi/);
      assert.equal((await readJson(piAuthPath(home))).fireworks.key, NEW_KEY);
    });
  });

  it("does not refresh the retired websearch MCP", async () => {
    await withTempHome("key-sync-websearch-mcp-", async (home) => {
      const { WEBSEARCH_MCP_SERVER_NAME, WEBSEARCH_MCP_URL, claudeJsonPath } =
        await import("../../lib/system/websearch-state.mjs");
      await writeJsonFile(claudeJsonPath(home), {
        mcpServers: {
          [WEBSEARCH_MCP_SERVER_NAME]: {
            type: "http",
            url: WEBSEARCH_MCP_URL,
            headers: { Authorization: "Bearer ${FIREWORKS_API_KEY}" },
          },
        },
      });

      const notes = await syncBakedKeysAfterStore(home, NEW_KEY);
      assert.deepEqual(notes, []);

      const claudeJson = await readJson(claudeJsonPath(home));
      assert.equal(
        claudeJson.mcpServers[WEBSEARCH_MCP_SERVER_NAME].headers.Authorization,
        "Bearer ${FIREWORKS_API_KEY}",
      );
    });
  });

  it("does nothing on a machine with no router configs", async () => {
    await withTempHome("key-sync-empty-", async (home) => {
      assert.deepEqual(await syncBakedKeysAfterStore(home, NEW_KEY), []);
    });
  });

  it("ignores empty input", async () => {
    assert.deepEqual(await syncBakedKeysAfterStore("", NEW_KEY), []);
    await withTempHome("key-sync-nokey-", async (home) => {
      assert.deepEqual(await syncBakedKeysAfterStore(home, "  "), []);
    });
  });
});
