import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync, unlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  VSCODE_FIREWORKS_MODEL_URL,
  FIRECONNECT_PROVIDER_NAME,
  addFireworksProvider,
  buildModelEntry,
  buildAzureModelEntry,
  fireconnectRegisteredModels,
  fireconnectSecretId,
  fireconnectSecretIds,
  fireworksProviderStatus,
  isFireconnectProvider,
  makeFireconnectSecretId,
  prettyModelName,
  removeFireconnectProvider,
  vscodeDataDir,
} from "../../../lib/harnesses/vscode/core.mjs";
import { FIRECONNECT_REFERER, runCli, runCliJson, withTempHome, itIfSqlite, mockServerlessModel } from "../../helpers.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";

/** A non-fireconnect provider (user-managed) to prove ownership scoping. */
function userProvider(name = "MyOther") {
  return {
    name,
    vendor: "customendpoint",
    apiType: "chat-completions",
    apiKey: "${input:chat.lm.secret.user-managed-id}",
    models: [{ id: "other-model", name: "Other", url: "https://other.example", toolCalling: false, vision: false, maxInputTokens: 8000, maxOutputTokens: 2000 }],
  };
}

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

/**
 * The application-scoped state.vscdb that sits beside chatLanguageModels.json
 * (`<dir>/globalStorage/state.vscdb`) — where VS Code stores secrets.
 */
function stateDbFor(vscodePath) {
  return path.join(path.dirname(vscodePath), "globalStorage", "state.vscdb");
}

/**
 * Read the `secret://<secretId>` row from a temp state.vscdb. Returns undefined
 * when the DB or row is absent. With NEXUS_VSCODE_SECRET_PLAINTEXT the
 * stored value is the raw key (no OS crypto), so this equals the API key.
 */
function readStateSecret(vscodePath, secretId) {
  const dbPath = stateDbFor(vscodePath);
  if (!existsSync(dbPath)) {
    return undefined;
  }
  const r = spawnSync("sqlite3", [dbPath, `SELECT value FROM ItemTable WHERE key='secret://${secretId}';`], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return undefined;
  }
  const out = (r.stdout || "").replace(/\n$/, "");
  return out === "" ? undefined : out;
}

/* -------------------------------------------------------------------------- */
/* Unit tests — pure transforms (no I/O)                                       */
/* -------------------------------------------------------------------------- */

describe("vscode-core pure transforms", () => {
  it("buildModelEntry produces the VS Code schema shape with per-model limits", () => {
    // The alias resolves from the API-reported `aliases` on the GLM 5.2 row.
    setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
      mockServerlessModel({
        aliases: ["accounts/fireworks/routers/glm-fast-latest"],
        context_length: 1_048_575,
      }),
    ]));
    try {
      const m = buildModelEntry("accounts/fireworks/routers/glm-fast-latest");
      assert.equal(m.id, "glm-fast-latest");
      assert.equal(m.name, "GLM Fast Latest");
      assert.equal(m.url, VSCODE_FIREWORKS_MODEL_URL);
      assert.equal(m.toolCalling, true);
      assert.equal(m.vision, false);
      assert.equal(m.maxInputTokens, 1_048_575);
      assert.equal(m.maxOutputTokens, 131072);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
    const other = buildModelEntry("accounts/fireworks/models/some-other");
    assert.equal(other.toolCalling, true);
    assert.equal(other.vision, false);
    assert.equal("maxInputTokens" in other, false);
    assert.equal("maxOutputTokens" in other, false);
  });

  it("buildModelEntry enables vision for firerouter", () => {
    const m = buildModelEntry("accounts/fireworks/routers/firerouter");
    assert.equal(m.id, "firerouter");
    assert.equal(m.vision, true);
    assert.equal(m.maxInputTokens, 1_048_575);
    assert.equal(m.maxOutputTokens, 131_072);
  });

  it("buildModelEntry registers auto under its bare slug with vision", () => {
    const m = buildModelEntry("auto");
    assert.equal(m.id, "auto");
    assert.equal(m.name, "Auto");
    assert.equal(m.vision, true);
    assert.equal(m.toolCalling, true);
    assert.equal(m.maxInputTokens, 1_048_575);
    assert.equal(m.maxOutputTokens, 131_072);
  });

  it("buildModelEntry registers auto-* under the variant slug with shared limits", () => {
    const m = buildModelEntry("auto-instant");
    assert.equal(m.id, "auto-instant");
    assert.equal(m.name, "Auto Instant");
    assert.equal(m.vision, true);
    assert.equal(m.maxInputTokens, 1_048_575);
  });

  it("buildAzureModelEntry sets maxInputTokens from the mapped Fireworks spec", () => {
    const m = buildAzureModelEntry("FW-GLM-5.2", "https://example.services.ai.azure.com/openai/v1");
    assert.equal(m.id, "FW-GLM-5.2");
    assert.equal(m.maxInputTokens, 1_048_575);
    assert.equal(m.maxOutputTokens, 131_072);
    assert.equal(m.vision, false);
  });

  it("addFireworksProvider appends a fireconnect-owned provider", () => {
    const secretId = makeFireconnectSecretId();
    const a = addFireworksProvider([], { secretId, models: [buildModelEntry("accounts/fireworks/routers/glm-latest")] });
    assert.equal(a.length, 1);
    assert.equal(a[0].name, FIRECONNECT_PROVIDER_NAME);
    assert.equal(a[0].vendor, "customendpoint");
    assert.equal(a[0].apiType, "chat-completions"); // default (direct Fireworks and Azure)
    assert.equal(a[0].apiKey, `\${input:${secretId}}`);
    assert.equal(fireconnectSecretId(a[0].apiKey), secretId);
    assert.equal(isFireconnectProvider(a[0]), true);
    // An explicit apiType override is still honored.
    const b = addFireworksProvider([], { secretId, models: [buildModelEntry("accounts/fireworks/routers/glm-latest")], apiType: "responses" });
    assert.equal(b[0].apiType, "responses");
  });

  it("addFireworksProvider replaces an existing fireconnect provider, leaves others alone", () => {
    const secretId = makeFireconnectSecretId();
    const other = userProvider();
    const a = addFireworksProvider([other], { secretId, models: [buildModelEntry("accounts/fireworks/routers/glm-latest")] });
    const a2 = addFireworksProvider(a, { secretId: makeFireconnectSecretId(), models: [buildModelEntry("accounts/fireworks/models/deepseek-v4-flash")] });
    assert.equal(a2.length, 2); // user provider + 1 fireconnect provider
    assert.equal(isFireconnectProvider(a2[0]), false); // user provider untouched
    const fw = a2.find(isFireconnectProvider);
    assert.equal(fw.models.length, 1);
    assert.equal(fw.models[0].id, "deepseek-v4-flash");
  });

  it("ownership: only fw- secret ids are fireconnect-owned", () => {
    assert.equal(isFireconnectProvider(userProvider()), false);
    assert.equal(fireconnectSecretId("${input:chat.lm.secret.user-xyz}"), null);
    assert.equal(fireconnectSecretId("fw_literals_are_not_owned"), null);
    assert.equal(isFireconnectProvider({ apiKey: "${input:chat.lm.secret.fw-abcd}" }), true);
  });

  it("removeFireconnectProvider only removes fireconnect-owned entries", () => {
    const a = addFireworksProvider([userProvider()], { secretId: makeFireconnectSecretId(), models: [buildModelEntry("accounts/fireworks/routers/glm-latest")] });
    const next = removeFireconnectProvider(a);
    assert.equal(next.length, 1);
    assert.equal(isFireconnectProvider(next[0]), false);
    assert.equal(fireworksProviderStatus(next), "none");
  });

  it("fireconnectSecretIds lists every fw- secret referenced", () => {
    const id1 = makeFireconnectSecretId();
    const a = addFireworksProvider([userProvider()], { secretId: id1, models: [buildModelEntry("accounts/fireworks/routers/glm-latest")] });
    assert.deepEqual(fireconnectSecretIds(a), [id1]);
  });

  it("prettyModelName renders human-readable names", () => {
    assert.equal(prettyModelName("accounts/fireworks/routers/glm-latest"), "GLM Latest");
    assert.equal(prettyModelName("accounts/fireworks/models/glm-5p2"), "GLM 5.2");
    assert.equal(prettyModelName("accounts/fireworks/models/deepseek-v4-flash"), "Deepseek V4 Flash");
    assert.equal(prettyModelName(""), "(unset)");
  });
});

/* -------------------------------------------------------------------------- */
/* Integration tests — CLI against a temp chatLanguageModels.json + the sibling */
/* state.vscdb. NEXUS_VSCODE_SECRET_PLAINTEXT bypasses the OS safeStorage  */
/* crypto (the secret is stored verbatim), so these run headless / on CI with   */
/* no keychain prompt. `--force` downgrades the running-VS-Code guard to a warn  */
/* so the suite passes whether or not VS Code happens to be open.               */
/* -------------------------------------------------------------------------- */

describe("vscode harness integration", () => {
  const secretEnv = () => ({ NEXUS_VSCODE_SECRET_PLAINTEXT: "1" });

  itIfSqlite("on writes the provider, the ${input:...} reference, and stores the key", async () => {
    await withTempHome("vscode-on-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--api-key", "fw_test_key_12345", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const arr = await readJson(vscodePath);
      assert.equal(arr.length, 1);
      const provider = arr[0];
      assert.equal(provider.name, FIRECONNECT_PROVIDER_NAME);
      assert.equal(provider.vendor, "customendpoint");
      // Direct Fireworks gateway uses the chat-completions API in VS Code Chat.
      assert.equal(provider.apiType, "chat-completions");
      assert.match(provider.apiKey, /^\$\{input:chat\.lm\.secret\.fw-[0-9a-f]+\}$/);
      assert.equal(provider.models[0].id, "auto");
      assert.equal(provider.models[0].requestHeaders["User-Agent"], undefined);
      assert.equal(provider.models[0].requestHeaders["X-Title"], "VS Code Chat");
      assert.equal(
        provider.models[0].requestHeaders["HTTP-Referer"],
        FIRECONNECT_REFERER,
      );
      assert.equal(provider.models[0].requestHeaders["X-FireRouter-Harness"], undefined);
      assert.equal(provider.models[0].requestHeaders["Fireworks-Use-Case"], undefined);
      assert.equal(provider.models[0].url, VSCODE_FIREWORKS_MODEL_URL);

      // The key is stored in state.vscdb under secret://<secretId>, NOT a
      // keychain entry — this is what VS Code Chat actually reads.
      const secretId = fireconnectSecretId(provider.apiKey);
      assert.equal(readStateSecret(vscodePath, secretId), "fw_test_key_12345");
    });
  });

  itIfSqlite("on preserves a user-managed provider and off restores the original file + deletes the secret", async () => {
    await withTempHome("vscode-off-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await mkdir(path.dirname(vscodePath), { recursive: true });
      const original = JSON.stringify([userProvider()], null, "\t") + "\n";
      await writeFile(vscodePath, original);

      const onR = await runCli(
        ["vscode", "on", "--api-key", "fw_test_key_12345", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(onR.code, 0, `stderr: ${onR.stderr}`);
      const enabled = await readJson(vscodePath);
      assert.equal(enabled.length, 2); // user provider + fireconnect provider
      assert.ok(enabled.some(isFireconnectProvider));
      assert.ok(enabled.some((p) => !isFireconnectProvider(p)));
      const secretId = fireconnectSecretIds(enabled)[0];
      assert.equal(readStateSecret(vscodePath, secretId), "fw_test_key_12345");

      const offR = await runCli(
        ["vscode", "off", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(offR.code, 0, `stderr: ${offR.stderr}`);
      assert.equal(await readFile(vscodePath, "utf8"), original); // restored byte-for-byte
      assert.equal(readStateSecret(vscodePath, secretId), undefined);
    });
  });

  it("repeat on updates telemetry without replacing model request headers", async () => {
    await withTempHome("vscode-headers-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await mkdir(path.dirname(vscodePath), { recursive: true });
      const original = `${JSON.stringify([userProvider()])}\n`;
      await writeFile(vscodePath, original);

      const first = await runCli(
        [
          "vscode", "on", "--api-key", "fw_cataloged_v1_adversarial000000",
          "--model", "deepseek-v4-flash", "--vscode-path", vscodePath, "--force",
        ],
        { home, env: secretEnv() },
      );
      assert.equal(first.code, 0, first.stderr);
      let models = await readJson(vscodePath);
      const provider = models.find(isFireconnectProvider);
      const existingModel = provider.models[0];
      assert.ok(existingModel);
      const modelId = existingModel.id;
      existingModel.requestHeaders["X-User-Trace"] = "keep";
      existingModel.requestHeaders["User-Agent"] = "custom-vscode/1.0";
      existingModel.requestHeaders["X-FireRouter-Harness"] = "vscode";
      existingModel.requestHeaders["Fireworks-Use-Case"] = "coding";
      existingModel.requestHeaders["HTTP-Referer"] =
        "fireconnect/v0.7.0";
      await writeFile(vscodePath, `${JSON.stringify(models, null, 2)}\n`);

      const repeat = await runCli(
        ["vscode", "on", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(repeat.code, 0, repeat.stderr);
      models = await readJson(vscodePath);
      const migratedModel = models.find(isFireconnectProvider).models
        .find((model) => model.id === modelId);
      assert.ok(migratedModel, JSON.stringify(models.find(isFireconnectProvider).models));
      assert.equal(migratedModel.id, modelId);
      const headers = migratedModel.requestHeaders;
      assert.equal(headers["X-User-Trace"], "keep");
      assert.equal(headers["User-Agent"], "custom-vscode/1.0");
      assert.equal(headers["X-Title"], "VS Code Chat");
      assert.equal(
        headers["HTTP-Referer"],
        FIRECONNECT_REFERER,
      );
      assert.equal(headers["X-FireRouter-Harness"], undefined);
      assert.equal(headers["Fireworks-Use-Case"], undefined);

      const off = await runCli(
        ["vscode", "off", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(off.code, 0, off.stderr);
      assert.equal(await readFile(vscodePath, "utf8"), original);
    });
  });

  it("on --model selects the requested model", async () => {
    await withTempHome("vscode-main-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--api-key", "fw_test_key_12345", "--model", "deepseek-v4-flash", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const arr = await readJson(vscodePath);
      assert.equal(arr[0].models[0].id, "deepseek-v4-flash");
    });
  });

  it("rejects --model firerouter in VS Code", async () => {
    await withTempHome("vscode-on-firerouter-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const on = await runCli(
        ["vscode", "on", "--model", "firerouter", "--api-key", "fw_test_key_12345", "--vscode-path", vscodePath, "--force"],
        { home, env: { ...secretEnv(), FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" } },
      );
      assert.notEqual(on.code, 0);
      assert.match(on.stderr, /is a FireRouter route, which is no longer supported/);
    });
  });

  it("rejects --model firerouter with an Anthropic BYOK flag in VS Code", async () => {
    const anthropicKey = "sk-ant-vscode-firerouter-12345";
    await withTempHome("vscode-on-firerouter-byok-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const on = await runCli(
        [
          "vscode", "on",
          "--model", "firerouter",
          "--api-key", "fw_test_key_12345",
          "--anthropic-api-key", anthropicKey,
          "--vscode-path", vscodePath,
          "--force",
        ],
        { home, env: { ...secretEnv(), FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } },
      );
      assert.notEqual(on.code, 0);
      assert.match(on.stderr, /is a FireRouter route, which is no longer supported/);
    });
  });

  it("rejects --model firerouter with an OpenAI BYOK flag in VS Code", async () => {
    const openaiKey = "sk-proj-vscode-firerouter-12345";
    await withTempHome("vscode-on-firerouter-openai-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const on = await runCli(
        [
          "vscode", "on",
          "--model", "firerouter",
          "--api-key", "fw_test_key_12345",
          "--openai-api-key", openaiKey,
          "--vscode-path", vscodePath,
          "--force",
        ],
        { home, env: { ...secretEnv(), FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } },
      );
      assert.notEqual(on.code, 0);
      assert.match(on.stderr, /is a FireRouter route, which is no longer supported/);
    });
  });

  it("status --json reports provider, model url, and registered models", async () => {
    await withTempHome("vscode-status-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(["vscode", "on", "--api-key", "fw_test_key_12345", "--vscode-path", vscodePath, "--force"], { home, env: secretEnv() });
      const legacy = await readJson(vscodePath);
      const provider = legacy.find(isFireconnectProvider);
      provider.models = [{
        ...provider.models[0],
        id: "accounts/fireworks/routers/glm-fast-latest",
      }];
      await writeFile(vscodePath, `${JSON.stringify(legacy, null, "\t")}\n`);
      const r = await runCliJson(["vscode", "status", "--vscode-path", vscodePath, "--json"], { home, env: secretEnv() });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.harness, "vscode");
      assert.equal(r.json.provider, "fireworks");
      assert.equal(r.json.modelUrl, VSCODE_FIREWORKS_MODEL_URL);
      assert.equal(r.json.hasKey, true);
      assert.deepEqual(r.json.registeredModels, ["accounts/fireworks/routers/glm-fast-latest"]);
    });
  });

  it("status works against a missing file (read-only, no throw)", async () => {
    await withTempHome("vscode-missing-", async (home) => {
      const vscodePath = path.join(home, "does-not-exist.json");
      const r = await runCliJson(["vscode", "status", "--vscode-path", vscodePath, "--json"], { home, env: secretEnv() });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.provider, "none");
      assert.equal(r.json.hasKey, false);
    });
  });

  itIfSqlite("off with no backup strips fireconnect-managed provider only", async () => {
    await withTempHome("vscode-strip-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(["vscode", "on", "--api-key", "fw_test_key_12345", "--vscode-path", vscodePath, "--force"], { home, env: secretEnv() });
      const enabled = await readJson(vscodePath);
      const secretId = fireconnectSecretIds(enabled)[0];

      // Inject a user-managed provider alongside, then remove the backup to
      // simulate a no-backup state.
      const withUser = [...enabled, userProvider()];
      await writeFile(vscodePath, JSON.stringify(withUser, null, "\t") + "\n");
      const backupDir = vscodeDataDir(home);
      for (const f of readdirSync(backupDir)) {
        if (f.startsWith("vscode-backup.")) unlinkSync(path.join(backupDir, f));
      }

      const r = await runCli(["vscode", "off", "--vscode-path", vscodePath, "--force"], { home, env: secretEnv() });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const after = await readJson(vscodePath);
      assert.equal(after.length, 1);
      assert.equal(isFireconnectProvider(after[0]), false); // user provider kept
      assert.equal(readStateSecret(vscodePath, secretId), undefined);
    });
  });

  itIfSqlite("re-running on preserves models added via on --model", async () => {
    await withTempHome("vscode-reon-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      // Keep this sequence independent of automatic FireRouter registration.
      const env = { ...secretEnv(), FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" };
      await runCli(["vscode", "on", "--api-key", "fw_test_key_12345", "--vscode-path", vscodePath, "--force"], { home, env });
      await runCli(["vscode", "on", "--model", "deepseek-v4-flash", "--vscode-path", vscodePath, "--force"], { home, env });

      // Re-run on (e.g. to rotate the key) without --model.
      const r = await runCli(["vscode", "on", "--api-key", "fw_test_key_99999", "--vscode-path", vscodePath, "--force"], { home, env });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const arr = await readJson(vscodePath);
      const ids = arr.find(isFireconnectProvider).models.map((m) => m.id);
      assert.deepEqual(ids.sort(), ["auto", "deepseek-v4-flash"]);
      // Key was rotated in place under the same secretId.
      const secretId = fireconnectSecretIds(arr)[0];
      assert.equal(readStateSecret(vscodePath, secretId), "fw_test_key_99999");
    });
  });

  it("on treats a non-array chatLanguageModels.json as empty", async () => {
    await withTempHome("vscode-nonarr-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await mkdir(path.dirname(vscodePath), { recursive: true });
      await writeFile(vscodePath, JSON.stringify({ not: "an array" }, null, "\t") + "\n");

      const r = await runCli(["vscode", "on", "--api-key", "fw_test_key_12345", "--vscode-path", vscodePath, "--force"], { home, env: secretEnv() });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const arr = await readJson(vscodePath);
      assert.ok(Array.isArray(arr));
      assert.equal(arr.find(isFireconnectProvider).models[0].id, "auto");
    });
  });

  it("on rejects an invalid JSON file with a clear error", async () => {
    await withTempHome("vscode-badjson-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await mkdir(path.dirname(vscodePath), { recursive: true });
      await writeFile(vscodePath, "{ broken json,,,");

      const r = await runCli(["vscode", "on", "--api-key", "fw_test_key_12345", "--vscode-path", vscodePath, "--force"], { home, env: secretEnv() });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /not valid JSON/);
    });
  });
});
