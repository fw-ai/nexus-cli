import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fireconnectSecretId, findFireconnectProvider, buildAzureModelEntry } from "../../../lib/harnesses/vscode/core.mjs";
import { lookupAzureFoundryModelLimits } from "../../../lib/fireworks/azure-core.mjs";
import { runCli, runCliJson, withTempHome, itIfSqlite } from "../../helpers.mjs";

const AZURE_ENDPOINT = "https://msft-fw-foundry-resource.services.ai.azure.com";
const AZURE_BASE_URL = "https://msft-fw-foundry-resource.services.ai.azure.com/openai/v1";
const AZURE_KEY = "azure-test-key-1234567890";

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

function stateDbFor(vscodePath) {
  return path.join(path.dirname(vscodePath), "globalStorage", "state.vscdb");
}

function readStateSecret(vscodePath, secretId) {
  const dbPath = stateDbFor(vscodePath);
  if (!existsSync(dbPath)) {
    return undefined;
  }
  const r = spawnSync("sqlite3", [dbPath, `SELECT value FROM ItemTable WHERE key='secret://${secretId}';`], {
    encoding: "utf8",
  });
  const raw = (r.stdout ?? "").replace(/\n$/, "");
  return raw || undefined;
}

// Plaintext secret mode: the stored secret equals the raw key (no OS crypto),
// and encryption is always "available" so `on` works headless.
const azureEnv = (extra = {}) => ({
  NEXUS_VSCODE_SECRET_PLAINTEXT: "1",
  FIREWORKS_API_KEY: "",
  AZURE_API_KEY: "",
  ...extra,
});

async function azureSecretId(vscodePath) {
  const provider = findFireconnectProvider(await readJson(vscodePath));
  return provider ? fireconnectSecretId(provider.apiKey) : null;
}

describe("vscode azure harness", () => {
  itIfSqlite("on --azure adds a chat-completions provider pointed at Foundry with the deployment", async () => {
    await withTempHome("vscode-azure-on-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--model", "FW-MiniMax-M2.5", "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv() },
      );
      assert.equal(r.code, 0, r.stderr);

      const arr = await readJson(vscodePath);
      const provider = findFireconnectProvider(arr);
      assert.equal(provider.apiType, "chat-completions");
      assert.deepEqual(provider.models.map((m) => m.id), ["FW-MiniMax-M2.5"]);
      assert.equal(provider.models[0].url, AZURE_BASE_URL);
      const limits = lookupAzureFoundryModelLimits("FW-MiniMax-M2.5");
      assert.equal(provider.models[0].maxInputTokens, limits.contextWindow);
      assert.equal(provider.models[0].maxOutputTokens, limits.maxTokens);
      assert.equal(readStateSecret(vscodePath, await azureSecretId(vscodePath)), AZURE_KEY);
    });
  });

  itIfSqlite("defaults the deployment and normalizes a portal project endpoint", async () => {
    await withTempHome("vscode-azure-default-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--azure", "--base-url", "https://r.services.ai.azure.com/api/projects/p1", "--api-key", AZURE_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv() },
      );
      assert.equal(r.code, 0, r.stderr);

      const provider = findFireconnectProvider(await readJson(vscodePath));
      assert.deepEqual(provider.models.map((m) => m.id), ["FW-GLM-5.2"]);
      assert.equal(provider.models[0].url, "https://r.services.ai.azure.com/openai/v1");
    });
  });

  itIfSqlite("uses an env-provided AZURE_API_KEY", async () => {
    await withTempHome("vscode-azure-env-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv({ AZURE_API_KEY: AZURE_KEY }) },
      );
      assert.equal(r.code, 0, r.stderr);
      assert.equal(readStateSecret(vscodePath, await azureSecretId(vscodePath)), AZURE_KEY);
    });
  });

  itIfSqlite("fails without a base URL", async () => {
    await withTempHome("vscode-azure-nobase-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--azure", "--api-key", AZURE_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv() },
      );
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /No Azure endpoint/);
    });
  });

  itIfSqlite("on/off round-trip restores the file byte-for-byte and deletes the secret", async () => {
    await withTempHome("vscode-azure-off-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await mkdir(path.dirname(vscodePath), { recursive: true });
      const original = `${JSON.stringify([{ name: "Mine", vendor: "customendpoint", apiType: "chat-completions", apiKey: "${input:chat.lm.secret.user-id}", models: [] }], null, "\t")}\n`;
      await writeFile(vscodePath, original);

      await runCli(
        ["vscode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv() },
      );
      const secretId = await azureSecretId(vscodePath);

      const off = await runCli(["vscode", "off", "--vscode-path", vscodePath, "--force"], { home, env: azureEnv() });
      assert.equal(off.code, 0, off.stderr);
      assert.equal(await readFile(vscodePath, "utf8"), original);
      assert.equal(readStateSecret(vscodePath, secretId), undefined);
    });
  });

  itIfSqlite("status reports the azure provider, endpoint, and deployment", async () => {
    await withTempHome("vscode-azure-status-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv() },
      );
      const status = await runCliJson(["vscode", "status", "--vscode-path", vscodePath, "--json"], { home, env: azureEnv() });
      const payload = status.json;
      assert.equal(payload.provider, "azure");
      assert.equal(payload.baseUrl, AZURE_BASE_URL);
      assert.equal(payload.modelProvider, "fireworks-azure");
      assert.equal(payload.hasKey, true);
      assert.equal(payload.current.main, "FW-GLM-5.2");
    });
  });

  itIfSqlite("re-on without --base-url reuses the stored endpoint and applies --model", async () => {
    await withTempHome("vscode-azure-reon-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv() },
      );
      const reon = await runCli(
        ["vscode", "on", "--azure", "--model", "FW-MiniMax-M2.5", "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv() },
      );
      assert.equal(reon.code, 0, reon.stderr);

      const provider = findFireconnectProvider(await readJson(vscodePath));
      assert.deepEqual(provider.models.map((m) => m.id), ["FW-MiniMax-M2.5"]);
      assert.equal(provider.models[0].url, AZURE_BASE_URL);
    });
  });

  itIfSqlite("switching from the Fireworks gateway to Azure replaces the catalog with the deployment", async () => {
    await withTempHome("vscode-azure-switch-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const fw = await runCli(
        ["vscode", "on", "--api-key", "fw_test_key_12345", "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv({ FIREWORKS_API_KEY: "" }) },
      );
      assert.equal(fw.code, 0, fw.stderr);

      const az = await runCli(
        ["vscode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: azureEnv() },
      );
      assert.equal(az.code, 0, az.stderr);

      const provider = findFireconnectProvider(await readJson(vscodePath));
      assert.equal(provider.apiType, "chat-completions");
      assert.deepEqual(provider.models.map((m) => m.id), ["FW-GLM-5.2"]);
      assert.equal(provider.models[0].url, AZURE_BASE_URL);
      assert.equal(readStateSecret(vscodePath, await azureSecretId(vscodePath)), AZURE_KEY);
    });
  });
});
