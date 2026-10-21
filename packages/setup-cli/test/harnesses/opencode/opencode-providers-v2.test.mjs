import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  disableOpencodeFireworks,
  enableOpencodeAzure,
  enableOpencodeFireworks,
  opencodeBackupPath,
  refreshOpencodeGatewayKey,
  removeOpencodeSavedProviderKeys,
} from "../../../lib/harnesses/opencode/core.mjs";
import {
  dropOpencodeProvider,
  mirrorOpencodeV2Providers,
  opencodeV2ProviderEntry,
} from "../../../lib/harnesses/opencode/providers-v2.mjs";

process.env.NEXUS_TEST ??= "1";

const KEY = "fw_test_key_12345"; // pragma: allowlist secret
const ROTATED_KEY = "fw_rotated_key_67890"; // pragma: allowlist secret
const AZURE_BASE_URL = "https://example.services.ai.azure.com";
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempConfig(initial) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-v2-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "opencode.json");
  const dataDir = path.join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  if (initial !== undefined) {
    await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`);
  }
  return { configPath, dataDir };
}

async function readConfig(configPath) {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function enableAuto(paths, extra = {}) {
  return enableOpencodeFireworks({
    ...paths,
    apiKey: KEY,
    effectiveApiKey: KEY,
    modelId: "auto",
    catalogModelIds: ["auto"],
    ...extra,
  });
}

function enableAzure(paths) {
  return enableOpencodeAzure({
    ...paths,
    apiKey: "azure-key",
    apiKeyFromFlag: true,
    baseUrl: AZURE_BASE_URL,
  });
}

describe("opencode v2 providers on enable", () => {
  it("replaces a native fireworks-ai entry with the managed one so auto is listed", async () => {
    const paths = await tempConfig({
      providers: {
        "fireworks-ai": {
          canonical: "openai",
          package: "aisdk:@ai-sdk/openai",
          settings: { apiKey: "fw_old", baseURL: "https://elsewhere.example/v1" },
          models: { mine: { disabled: true } },
        },
        anthropic: { settings: { apiKey: "sk-ant-x" } }, // pragma: allowlist secret
      },
    });

    await enableAuto(paths);

    const config = await readConfig(paths.configPath);
    assert.equal(config.model, "fireworks-ai/auto");
    assert.deepEqual(
      config.providers["fireworks-ai"],
      opencodeV2ProviderEntry(config.provider["fireworks-ai"]),
    );
    assert.equal(config.providers["fireworks-ai"].settings.apiKey, KEY);
    assert.equal(config.providers["fireworks-ai"].settings.baseURL, undefined);
    assert.equal(config.providers["fireworks-ai"].canonical, undefined);
    assert.ok(config.providers["fireworks-ai"].models.auto);
    assert.deepEqual(config.providers.anthropic, { settings: { apiKey: "sk-ant-x" } }); // pragma: allowlist secret
  });

  it("leaves v1-only configs without a providers key", async () => {
    const paths = await tempConfig({ model: "openai/gpt-4" });
    await enableAuto(paths);
    const config = await readConfig(paths.configPath);
    assert.ok(config.provider["fireworks-ai"]);
    assert.equal(Object.hasOwn(config, "providers"), false);
  });

  it("keeps a native fireworks-azure entry it never managed when enabling Fireworks", async () => {
    const native = { settings: { apiKey: "{env:MY_AZURE}" } };
    const paths = await tempConfig({ providers: { "fireworks-azure": native } });
    await enableAuto(paths);
    assert.deepEqual((await readConfig(paths.configPath)).providers["fireworks-azure"], native);
  });

  it("keeps a native fireworks-ai entry it never managed when enabling Azure", async () => {
    const native = { name: "My FW", settings: { apiKey: "{env:MY_FW}" } };
    const paths = await tempConfig({ providers: { "fireworks-ai": native } });
    await enableAzure(paths);
    const config = await readConfig(paths.configPath);
    assert.deepEqual(config.providers["fireworks-ai"], native);
    assert.equal(config.providers["fireworks-azure"].package, "aisdk:@ai-sdk/openai-compatible");
  });

  it("swaps its own entries when switching Fireworks to Azure and back", async () => {
    const paths = await tempConfig({ providers: {} });
    await enableAuto(paths);
    await enableAzure(paths);
    let config = await readConfig(paths.configPath);
    assert.deepEqual(Object.keys(config.providers), ["fireworks-azure"]);
    assert.deepEqual(config.providers["fireworks-azure"].settings, {
      baseURL: config.provider["fireworks-azure"].options.baseURL,
      apiKey: "azure-key",
    });

    await enableAuto(paths);
    config = await readConfig(paths.configPath);
    assert.deepEqual(Object.keys(config.providers), ["fireworks-ai"]);
    assert.deepEqual(Object.keys(config.provider), ["fireworks-ai"]);
  });

  it("skips malformed v1 model rows instead of failing the write", async () => {
    const paths = await tempConfig({
      providers: {},
      provider: { "fireworks-ai": { options: { apiKey: KEY }, models: { "glm-latest": null } } },
      model: "fireworks-ai/glm-latest",
    });
    await enableAuto(paths);
    const config = await readConfig(paths.configPath);
    assert.equal(config.provider["fireworks-ai"].models["glm-latest"], null);
    assert.equal(Object.hasOwn(config.providers["fireworks-ai"].models, "glm-latest"), false);
  });

  it("keeps the v2 entry in sync on key rotation and header removal", async () => {
    const paths = await tempConfig({ providers: {} });
    await enableAuto(paths, {
      modelId: "firerouter",
      byokHeaders: { "x-anthropic-api-key": "sk-ant-test" }, // pragma: allowlist secret
    });
    const synced = async () => {
      const config = await readConfig(paths.configPath);
      assert.deepEqual(
        config.providers["fireworks-ai"],
        opencodeV2ProviderEntry(config.provider["fireworks-ai"]),
      );
      return config.providers["fireworks-ai"];
    };
    assert.equal((await synced()).headers["x-anthropic-api-key"], "sk-ant-test"); // pragma: allowlist secret

    assert.equal(await refreshOpencodeGatewayKey({ configPath: paths.configPath, fireworksKey: ROTATED_KEY }), true);
    assert.equal((await synced()).settings.apiKey, ROTATED_KEY);

    assert.equal(
      await removeOpencodeSavedProviderKeys({ configPath: paths.configPath, headerNames: ["x-anthropic-api-key"] }),
      true,
    );
    assert.equal((await synced()).headers, undefined);
  });
});

describe("opencode v2 providers on disable", () => {
  it("strips the mirrored entries when no backup exists", async () => {
    const paths = await tempConfig({ providers: { anthropic: { settings: {} } } });
    await enableAuto(paths);
    await unlink(opencodeBackupPath(paths.dataDir, paths.configPath));

    assert.equal(await disableOpencodeFireworks({ ...paths, wasEnabled: true }), "stripped");
    assert.deepEqual(await readConfig(paths.configPath), { providers: { anthropic: { settings: {} } } });
  });

  it("keeps a native entry it never managed when no backup exists", async () => {
    const native = { settings: { apiKey: "fw_users_own" } };
    const paths = await tempConfig({
      model: "fireworks-ai/glm-latest",
      providers: { "fireworks-ai": native },
    });

    assert.equal(await disableOpencodeFireworks({ ...paths, wasEnabled: true }), "stripped");
    assert.deepEqual(await readConfig(paths.configPath), { providers: { "fireworks-ai": native } });
  });

  it("drops an empty provider map like v1-only off does, but keeps an untouched empty providers map", async () => {
    const paths = await tempConfig({ provider: {}, providers: {}, model: "fireworks-ai/glm-latest" });
    assert.equal(await disableOpencodeFireworks({ ...paths, wasEnabled: true }), "stripped");
    assert.deepEqual(await readConfig(paths.configPath), { providers: {} });
  });

  it("does not leak the mirror into the backup: off restores the original bytes", async () => {
    const paths = await tempConfig({ providers: { "fireworks-ai": { settings: { apiKey: "fw_mine" } } } });
    const raw = await readFile(paths.configPath, "utf8");
    await enableAuto(paths);
    assert.equal(await disableOpencodeFireworks({ ...paths, wasEnabled: true }), "restored");
    assert.equal(await readFile(paths.configPath, "utf8"), raw);
  });
});

describe("mirrorOpencodeV2Providers / dropOpencodeProvider", () => {
  const legacy = { options: { apiKey: KEY } };

  it("ignores a providers value that is not a plain object", () => {
    for (const providers of [null, [], "x"]) {
      const config = { provider: { "fireworks-ai": legacy }, providers };
      assert.equal(mirrorOpencodeV2Providers(config, ["fireworks-ai"]), config);
    }
  });

  it("never deletes entries, even for owned ids without a v1 entry", () => {
    const native = { settings: {} };
    const config = { providers: { "fireworks-azure": native } };
    assert.deepEqual(
      mirrorOpencodeV2Providers(config, ["fireworks-ai", "fireworks-azure"]).providers,
      { "fireworks-azure": native },
    );
  });

  it("drops both maps only when the v1 entry exists", () => {
    const config = { provider: { "fireworks-ai": legacy }, providers: { "fireworks-ai": {}, other: {} } };
    assert.deepEqual(dropOpencodeProvider(config, "fireworks-ai"), { provider: {}, providers: { other: {} } });
    const nativeOnly = { providers: { "fireworks-ai": {} } };
    assert.equal(dropOpencodeProvider(nativeOnly, "fireworks-ai"), nativeOnly);
  });
});

describe("opencodeV2ProviderEntry", () => {
  it("translates a FireConnect gateway entry", () => {
    assert.deepEqual(
      opencodeV2ProviderEntry({
        options: { apiKey: KEY, headers: { "x-a": "1", bad: 2 } },
        models: {
          m: {
            name: "M",
            limit: { context: 10.9, output: 5 },
            cost: { input: 1, output: 2, cache_read: 0.5 },
            modalities: { input: ["text", "image"] },
          },
          plain: { name: "Plain" },
        },
      }),
      {
        settings: { apiKey: KEY },
        headers: { "x-a": "1" },
        models: {
          m: {
            name: "M",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            cost: [{ input: 1, output: 2, cache: { read: 0.5 } }],
            limit: { context: 10, output: 5 },
          },
          plain: { name: "Plain" },
        },
      },
    );
  });

  it("translates npm, api, body and hand-edited v1 model fields", () => {
    assert.deepEqual(
      opencodeV2ProviderEntry({
        name: "Azure",
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.example/v1",
        env: ["AZURE_API_KEY"],
        options: { apiKey: "{env:AZURE_API_KEY}", body: { a: 1 } },
        models: {
          d: {
            id: "upstream-id",
            tool_call: false,
            modalities: { output: ["text"] },
            interleaved: { field: "reasoning_content" },
            options: { thinking: { blockBinding: false } },
            status: "deprecated",
            variants: { fast: { reasoningEffort: "low" } },
            cost: { input: 1, output: 2, context_over_200k: { input: 3, output: 4, cache_write: 1 } },
          },
        },
      }),
      {
        name: "Azure",
        env: ["AZURE_API_KEY"],
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { apiKey: "{env:AZURE_API_KEY}", baseURL: "https://api.example/v1" },
        body: { a: 1 },
        models: {
          d: {
            modelID: "upstream-id",
            compatibility: { reasoningField: "reasoning_content", supportsThinkingBlockBinding: false },
            settings: {},
            capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
            variants: [{ id: "fast", settings: { reasoningEffort: "low" } }],
            cost: [
              { input: 1, output: 2, cache: {} },
              { tier: { type: "context", size: 200_000 }, input: 3, output: 4, cache: { write: 1 } },
            ],
            disabled: true,
          },
        },
      },
    );
  });
});
