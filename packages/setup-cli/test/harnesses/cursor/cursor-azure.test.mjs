import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CURSOR_DEFAULT_MODE, cursorCurrentModelId } from "../../../lib/harnesses/cursor/core.mjs";
import { runCli, withTempHome } from "../../helpers.mjs";

const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

const AZURE_ENDPOINT = "https://msft-fw-foundry-resource.services.ai.azure.com";
const AZURE_BASE_URL = "https://msft-fw-foundry-resource.services.ai.azure.com/openai/v1";
const AZURE_KEY = "azure-test-key-1234567890";

function baseBlob(overrides = {}) {
  return {
    openAIBaseUrl: null,
    useOpenAIKey: false,
    aiSettings: {
      userAddedModels: [],
      modelOverrideEnabled: [],
      modelConfig: {
        composer: { modelName: "default", maxMode: true, selectedModels: [{ modelId: "default", parameters: [] }] },
      },
    },
    ...overrides,
  };
}

function jsonLit(v) {
  return JSON.stringify(v).replace(/'/g, "''");
}

function writeCursorDb(dbPath, blob, opts = {}) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT OR REPLACE INTO ItemTable(key,value) VALUES('${APPLICATION_USER_KEY}','${jsonLit(blob)}');`,
  ];
  if (opts.openAIKey != null) {
    const keyLit = String(opts.openAIKey).replace(/'/g, "''");
    sql.push(`INSERT OR REPLACE INTO ItemTable(key,value) VALUES('cursorAuth/openAIKey','${keyLit}');`);
  }
  const r = spawnSync("sqlite3", [dbPath, sql.join("\n")], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(`sqlite3 init failed: ${r.stderr || r.error?.message}`);
  }
}

function readBlob(dbPath) {
  const r = spawnSync("sqlite3", [dbPath, `SELECT value FROM ItemTable WHERE key='${APPLICATION_USER_KEY}';`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = (r.stdout ?? "").replace(/\n$/, "");
  return raw ? JSON.parse(raw) : null;
}

function readKey(dbPath) {
  const r = spawnSync("sqlite3", [dbPath, "SELECT value FROM ItemTable WHERE key='cursorAuth/openAIKey';"], {
    encoding: "utf8",
  });
  return (r.stdout ?? "").replace(/\n$/, "");
}

const HAS_SQLITE = spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0;
const itIfSqlite = HAS_SQLITE ? it : it.skip;

const AZURE_ENV = { FIREWORKS_API_KEY: "", AZURE_API_KEY: "" };

describe("cursor azure harness", () => {
  itIfSqlite("firerouter is rejected in Azure mode", async () => {
    await withTempHome("cursor-azure-firerouter-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const result = await runCli(
        [
          "cursor", "on", "--azure", "--base-url", AZURE_ENDPOINT,
          "--api-key", AZURE_KEY, "--model", "firerouter",
          "--db-path", dbPath, "--force",
        ],
        { home, env: AZURE_ENV },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /FireRouter is not supported in Cursor Azure mode/);
      assert.doesNotMatch(result.stderr, /needs workspace BYOK/);
    });
  });

  itIfSqlite("on --azure points the OpenAI override at Foundry and registers the deployment", async () => {
    await withTempHome("cursor-azure-on-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const r = await runCli(
        ["cursor", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--model", "FW-MiniMax-M2.5", "--db-path", dbPath, "--force"],
        { home, env: AZURE_ENV },
      );
      assert.equal(r.code, 0, r.stderr);

      const blob = readBlob(dbPath);
      assert.equal(blob.openAIBaseUrl, AZURE_BASE_URL);
      assert.equal(blob.useOpenAIKey, true);
      assert.deepEqual(blob.aiSettings.userAddedModels, ["FW-MiniMax-M2.5"]);
      assert.deepEqual(blob.aiSettings.fireconnectAddedModels, ["FW-MiniMax-M2.5"]);
      assert.equal(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE), "FW-MiniMax-M2.5");
      assert.equal(readKey(dbPath), AZURE_KEY);
    });
  });

  itIfSqlite("keeps an Azure deployment name verbatim even when it looks canonical", async () => {
    await withTempHome("cursor-azure-verbatim-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const deployment = "accounts/fireworks/models/foundry-deployment";
      writeCursorDb(dbPath, baseBlob());

      const result = await runCli(
        [
          "cursor", "on", "--azure", "--base-url", AZURE_ENDPOINT,
          "--api-key", AZURE_KEY, "--model", deployment,
          "--db-path", dbPath, "--force",
        ],
        { home, env: AZURE_ENV },
      );
      assert.equal(result.code, 0, result.stderr);

      const blob = readBlob(dbPath);
      assert.deepEqual(blob.aiSettings.userAddedModels, [deployment]);
      assert.deepEqual(blob.aiSettings.fireconnectAddedModels, [deployment]);
      assert.equal(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE), deployment);
    });
  });

  itIfSqlite("defaults the deployment and normalizes a portal project endpoint", async () => {
    await withTempHome("cursor-azure-default-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const r = await runCli(
        ["cursor", "on", "--azure", "--base-url", "https://r.services.ai.azure.com/api/projects/p1", "--api-key", AZURE_KEY, "--db-path", dbPath, "--force"],
        { home, env: AZURE_ENV },
      );
      assert.equal(r.code, 0, r.stderr);

      const blob = readBlob(dbPath);
      assert.equal(blob.openAIBaseUrl, "https://r.services.ai.azure.com/openai/v1");
      assert.equal(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE), "FW-GLM-5.2");
    });
  });

  itIfSqlite("writes an env-provided AZURE_API_KEY literally into the DB", async () => {
    await withTempHome("cursor-azure-env-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const r = await runCli(
        ["cursor", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "", AZURE_API_KEY: AZURE_KEY } },
      );
      assert.equal(r.code, 0, r.stderr);
      assert.equal(readKey(dbPath), AZURE_KEY);
    });
  });

  itIfSqlite("fails without a base URL", async () => {
    await withTempHome("cursor-azure-nobase-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const r = await runCli(
        ["cursor", "on", "--azure", "--api-key", AZURE_KEY, "--db-path", dbPath, "--force"],
        { home, env: AZURE_ENV },
      );
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /No Azure endpoint/);
    });
  });

  itIfSqlite("on/off round-trip restores the pre-on blob and clears the key", async () => {
    await withTempHome("cursor-azure-off-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(
        ["cursor", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--db-path", dbPath, "--force"],
        { home, env: AZURE_ENV },
      );
      const off = await runCli(["cursor", "off", "--db-path", dbPath, "--force"], { home, env: AZURE_ENV });
      assert.equal(off.code, 0, off.stderr);

      const blob = readBlob(dbPath);
      assert.equal(blob.openAIBaseUrl, null);
      assert.equal(blob.useOpenAIKey, false);
      assert.equal(readKey(dbPath), "");
    });
  });

  itIfSqlite("status reports the azure provider, endpoint, and deployment", async () => {
    await withTempHome("cursor-azure-status-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(
        ["cursor", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--db-path", dbPath, "--force"],
        { home, env: AZURE_ENV },
      );
      const status = await runCli(["cursor", "status", "--json", "--db-path", dbPath], { home, env: AZURE_ENV });
      assert.equal(status.code, 0, status.stderr);
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.provider, "azure");
      assert.equal(payload.baseUrl, AZURE_BASE_URL);
      assert.equal(payload.modelProvider, "fireworks-azure");
      assert.equal(payload.hasKey, true);
      assert.equal(payload.current.main, "FW-GLM-5.2");

      const human = await runCli(["cursor", "status", "--db-path", dbPath], { home, env: AZURE_ENV });
      assert.equal(human.code, 0, human.stderr);
      assert.match(human.stdout, /Auth: stored in config/);
    });
  });

  itIfSqlite("re-on without --base-url reuses the stored endpoint and applies --model", async () => {
    await withTempHome("cursor-azure-reon-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(
        ["cursor", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--db-path", dbPath, "--force"],
        { home, env: AZURE_ENV },
      );
      const reon = await runCli(
        ["cursor", "on", "--azure", "--model", "FW-MiniMax-M2.5", "--db-path", dbPath, "--force"],
        { home, env: AZURE_ENV },
      );
      assert.equal(reon.code, 0, reon.stderr);

      const blob = readBlob(dbPath);
      assert.equal(blob.openAIBaseUrl, AZURE_BASE_URL);
      assert.equal(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE), "FW-MiniMax-M2.5");
    });
  });

  itIfSqlite("switching from the Fireworks gateway to Azure drops the gateway catalog", async () => {
    await withTempHome("cursor-azure-switch-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const fw = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "", AZURE_API_KEY: "" } },
      );
      assert.equal(fw.code, 0, fw.stderr);

      const az = await runCli(
        ["cursor", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--db-path", dbPath, "--force"],
        { home, env: AZURE_ENV },
      );
      assert.equal(az.code, 0, az.stderr);

      const blob = readBlob(dbPath);
      assert.equal(blob.openAIBaseUrl, AZURE_BASE_URL);
      assert.deepEqual(blob.aiSettings.fireconnectAddedModels, ["FW-GLM-5.2"]);
      assert.equal(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE), "FW-GLM-5.2");
      assert.equal(readKey(dbPath), AZURE_KEY);
    });
  });

  itIfSqlite("switching from Azure to Fireworks drops the verbatim deployment", async () => {
    await withTempHome("cursor-azure-to-fireworks-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const deployment = "accounts/fireworks/models/foundry-deployment";
      writeCursorDb(dbPath, baseBlob());

      const azure = await runCli(
        [
          "cursor", "on", "--azure", "--base-url", AZURE_ENDPOINT,
          "--api-key", AZURE_KEY, "--model", deployment,
          "--db-path", dbPath, "--force",
        ],
        { home, env: AZURE_ENV },
      );
      assert.equal(azure.code, 0, azure.stderr);

      const fireworks = await runCli(
        [
          "cursor", "on", "--api-key", "fw_test_key_12345",
          "--db-path", dbPath, "--force",
        ],
        { home, env: AZURE_ENV },
      );
      assert.equal(fireworks.code, 0, fireworks.stderr);

      const blob = readBlob(dbPath);
      assert.ok(blob.aiSettings.fireconnectAddedModels.includes("nexus/auto"));
      assert.equal(blob.aiSettings.fireconnectAddedModels.includes(deployment), false);
      assert.equal(
        blob.aiSettings.fireconnectAddedModels.includes("foundry-deployment"),
        false,
      );
      assert.equal(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE), "nexus/auto");
    });
  });
});
