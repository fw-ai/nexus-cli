import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enableOpencodeFireworks,
  opencodeNeedsProviderModelOverride,
  opencodeProviderModelKey,
} from "../../../lib/harnesses/opencode/core.mjs";
import {
  clearModelsDevFireworksRegistry,
  setModelsDevFireworksRegistry,
} from "../../../lib/fireworks/models-dev-registry.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { mockServerlessModel } from "../../helpers.mjs";

process.env.NEXUS_TEST ??= "1";

describe("opencode catalog model handling", () => {
  it("identifies router overrides vs models.dev catalog entries", () => {
    setModelsDevFireworksRegistry([
      "accounts/fireworks/models/deepseek-v4-flash",
      "accounts/fireworks/routers/glm-5p2-fast",
      "accounts/fireworks/routers/kimi-k3-fast",
    ]);
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/inkling",
        shortId: "inkling",
        displayName: "Inkling",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map([["accounts/fireworks/models/inkling", 1_048_576]]),
      supportsToolsById: new Map(),
    });
    try {
      for (const alias of [
        "glm-fast-latest",
        "glm-latest",
        "kimi-fast-latest",
        "kimi-latest",
        "minimax-latest",
        "qwen-plus-latest",
      ]) {
        assert.equal(opencodeNeedsProviderModelOverride(alias), true, alias);
        assert.equal(
          opencodeNeedsProviderModelOverride(`accounts/fireworks/routers/${alias}`),
          true,
          alias,
        );
      }
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/models/deepseek-v4-flash"), false);
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/routers/glm-5p2-fast"), false);
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/routers/kimi-k3-fast"), false);
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/models/inkling"), true);
      assert.equal(opencodeNeedsProviderModelOverride("firerouter"), true);
    } finally {
      clearModelsDevFireworksRegistry();
      setServerlessCatalogSnapshot(null);
    }
  });

  it("writes provider model overrides only for routers, not catalog models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-models-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    const catalogModelIds = [
      "accounts/fireworks/routers/glm-fast-latest",
      "accounts/fireworks/routers/glm-latest",
      "accounts/fireworks/routers/kimi-fast-latest",
      "accounts/fireworks/routers/minimax-latest",
      "accounts/fireworks/routers/qwen-plus-latest",
      "accounts/fireworks/models/deepseek-v4-flash",
      "accounts/fireworks/routers/glm-5p2-fast",
    ];

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      catalogModelIds,
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.model, "fireworks-ai/auto");
    const models = config.provider["fireworks-ai"].models;
    assert.equal(models["deepseek-v4-flash"], undefined);
    assert.equal(models["glm-5p2-fast"], undefined);
    assert.ok(models["glm-fast-latest"]);
    assert.ok(models["glm-latest"]);
    assert.ok(models["kimi-fast-latest"]);
    assert.ok(models["minimax-latest"]);
    assert.ok(models["qwen-plus-latest"]);
  });

  it("collapses legacy provider.models keys to one canonical slug", () => {
    assert.equal(opencodeProviderModelKey("glm-fast-latest"), "glm-fast-latest");
    assert.equal(
      opencodeProviderModelKey("accounts/fireworks/routers/glm-fast-latest"),
      "glm-fast-latest",
    );
    assert.equal(opencodeProviderModelKey("fireworks-ai/glm-fast-latest"), "glm-fast-latest");
  });

  it("keeps path-shaped firerouter* keys intact", () => {
    assert.equal(opencodeProviderModelKey("firerouter/x"), "firerouter/x");
    assert.equal(opencodeProviderModelKey("firerouter"), "firerouter");
  });

  it("writes firerouter* provider overrides under the full short ref", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-firerouter-path-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      modelId: "firerouter/x",
      catalogModelIds: ["accounts/fireworks/routers/glm-latest"],
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.model, "fireworks-ai/firerouter/x");
    const models = config.provider?.["fireworks-ai"]?.models ?? {};
    assert.ok(models["firerouter/x"], "override keyed by full short ref");
    assert.equal(models.x, undefined, "must not collapse to last path segment");
    assert.equal(models["firerouter/x"].limit.context, 1_048_575);
  });

  it("writes an explicit auto override so OpenCode doesn't fall back to 128K", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-auto-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      modelId: "auto",
      catalogModelIds: ["accounts/fireworks/routers/glm-latest"],
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.model, "fireworks-ai/auto");
    const entry = config.provider?.["fireworks-ai"]?.models?.auto;
    assert.ok(entry, "auto is absent from models.dev, so it needs an explicit override");
    assert.equal(entry.limit.context, 1_048_575);
    assert.equal(entry.limit.output, 131_072);
  });

  it("plain re-on only removes models missing from the catalog", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-reon-idempotent-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    const catalogModelIds = [
      "accounts/fireworks/routers/glm-fast-latest",
      "accounts/fireworks/routers/glm-latest",
      "accounts/fireworks/routers/kimi-fast-latest",
    ];

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      catalogModelIds,
      catalogAvailable: true,
    });

    // Legacy builds wrote catalog models and mixed full-id keys alongside short slugs.
    const stale = JSON.parse(await readFile(configPath, "utf8"));
    stale.provider["fireworks-ai"].models = {
      ...stale.provider["fireworks-ai"].models,
      "accounts/fireworks/routers/glm-fast-latest": { name: "legacy full id" },
      "fireworks-ai/glm-fast-latest": { name: "legacy provider prefix" },
      "deepseek-v4-flash": { name: "stale catalog model" },
    };
    await writeFile(configPath, `${JSON.stringify(stale, null, 2)}\n`);

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      catalogModelIds,
      catalogAvailable: true,
    });

    const models = JSON.parse(await readFile(configPath, "utf8")).provider["fireworks-ai"].models;
    assert.ok(models["accounts/fireworks/routers/glm-fast-latest"]);
    assert.ok(models["fireworks-ai/glm-fast-latest"]);
    assert.equal(models["deepseek-v4-flash"], undefined);
  });

  it("plain re-on refreshes existing model metadata", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-refresh-cost-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    const catalogModelIds = ["accounts/fireworks/routers/glm-latest"];

    // glm-latest resolves from the API-reported alias on the GLM 5.2 row.
    setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
      mockServerlessModel({
        aliases: ["accounts/fireworks/routers/glm-latest"],
      }),
    ]));
    try {
      const enable = () => enableOpencodeFireworks({
        configPath,
        dataDir,
        apiKey: "fw_test_key_12345",
        effectiveApiKey: "fw_test_key_12345",
        catalogModelIds,
      });
      await enable();

      const withCost = JSON.parse(await readFile(configPath, "utf8")).provider["fireworks-ai"].models["glm-latest"];
      assert.ok(withCost?.cost?.input, "standard key registers metered cost");

      const stale = JSON.parse(await readFile(configPath, "utf8"));
      stale.provider["fireworks-ai"].models["glm-latest"].cost = { input: 99, output: 99 };
      stale.provider["fireworks-ai"].models["glm-latest"].limit = { context: 1, output: 1 };
      await writeFile(configPath, `${JSON.stringify(stale, null, 2)}\n`);

      await enable();

      const entry = JSON.parse(await readFile(configPath, "utf8")).provider["fireworks-ai"].models["glm-latest"];
      assert.deepEqual(entry.cost, withCost.cost);
      assert.ok(entry.limit.context >= 1_000_000, "limits still resolved");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("offline re-on leaves existing provider model keys unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-offline-legacy-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      model: "fireworks-ai/glm-fast-latest",
      provider: {
        "fireworks-ai": {
          options: { apiKey: "fw_test_key_12345" },
          models: {
            "fireworks-ai/glm-fast-latest": { name: "legacy provider prefix" },
            "accounts/fireworks/routers/kimi-fast-latest": { name: "legacy full id" },
          },
        },
      },
    })}\n`);

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      catalogModelIds: [],
    });

    const models = JSON.parse(await readFile(configPath, "utf8")).provider["fireworks-ai"].models;
    assert.deepEqual(Object.keys(models).sort(), [
      "accounts/fireworks/routers/kimi-fast-latest",
      "fireworks-ai/glm-fast-latest",
    ]);
  });

  it("explicit model adds no unrelated entries or metadata refresh", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-offline-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      model: "fireworks-ai/kimi-latest",
      provider: {
        "fireworks-ai": {
          options: { apiKey: "fw_test_key_12345" },
          models: {
            "kimi-latest": { name: "kimi-latest" },
            "glm-fast-latest": { name: "glm-fast-latest" },
          },
        },
      },
    })}\n`);

    // Alias routers resolve from API-reported `aliases`; seed the vision-capable
    // Kimi K3 row and the fast GLM 5.2 row the catalog reports.
    setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k3",
        display_name: "Kimi K3",
        aliases: ["accounts/fireworks/routers/kimi-latest"],
        input_modalities: ["text", "image"],
        context_length: 1_040_000,
      }),
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p2",
        display_name: "GLM 5.2",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
        aliases: ["accounts/fireworks/routers/glm-fast-latest"],
        context_length: 1_048_575,
      }),
    ]));
    try {
      await enableOpencodeFireworks({
        configPath,
        dataDir,
        apiKey: "fw_test_key_12345",
        effectiveApiKey: "fw_test_key_12345",
        modelId: "kimi-latest",
        catalogModelIds: [],
      });

      const config = JSON.parse(await readFile(configPath, "utf8"));
      const models = config.provider["fireworks-ai"].models;
      assert.equal(models["kimi-latest"].modalities, undefined);
      assert.equal(models["glm-fast-latest"].modalities, undefined);
      assert.equal(models["glm-fast-latest"].limit, undefined);
      assert.equal(models["kimi-latest"].limit, undefined);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("requires inkling override when models.dev registry is unknown", () => {
    clearModelsDevFireworksRegistry();
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/inkling",
        shortId: "inkling",
        displayName: "Inkling",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map([["accounts/fireworks/models/inkling", 1_048_576]]),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/models/inkling"), true);
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/models/glm-5p2"), false);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("writes provider overrides for catalog models absent from models.dev", async () => {
    setModelsDevFireworksRegistry([
      "accounts/fireworks/models/deepseek-v4-flash",
    ]);
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/inkling",
        shortId: "inkling",
        displayName: "Inkling",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map([["accounts/fireworks/models/inkling", ["text", "image"]]]),
      routerBaseModelById: new Map(),
      contextLengthById: new Map([["accounts/fireworks/models/inkling", 1_048_576]]),
      supportsToolsById: new Map(),
    });
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-inkling-"));
      const configPath = path.join(home, "opencode.json");
      const dataDir = path.join(home, "data");
      await mkdir(dataDir, { recursive: true });

      await enableOpencodeFireworks({
        configPath,
        dataDir,
        apiKey: "fw_test_key_12345",
        effectiveApiKey: "fw_test_key_12345",
        modelId: "inkling",
        catalogModelIds: [
          "accounts/fireworks/models/inkling",
          "accounts/fireworks/models/deepseek-v4-flash",
        ],
      });

      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.model, "fireworks-ai/inkling");
      const inkling = config.provider["fireworks-ai"].models.inkling;
      assert.equal(inkling.limit.context, 1_048_576);
      assert.equal(inkling.limit.output, 131_072);
      assert.deepEqual(inkling.modalities, { input: ["text", "image"] });
      assert.equal(config.provider["fireworks-ai"].models["deepseek-v4-flash"], undefined);
    } finally {
      clearModelsDevFireworksRegistry();
      setServerlessCatalogSnapshot(null);
    }
  });
});

describe("opencode skips overrides for models OpenCode already lists", () => {
  const GLM_LATEST = "accounts/fireworks/routers/glm-latest";
  const KIMI_LATEST = "accounts/fireworks/routers/kimi-latest";

  it("treats any models.dev-listed id as covered, including router aliases", () => {
    setModelsDevFireworksRegistry([GLM_LATEST]);
    try {
      assert.equal(opencodeNeedsProviderModelOverride("glm-latest"), false);
      assert.equal(opencodeNeedsProviderModelOverride(GLM_LATEST), false);
      assert.equal(opencodeNeedsProviderModelOverride("kimi-latest"), true);
      assert.equal(opencodeNeedsProviderModelOverride("auto"), true);
      assert.equal(opencodeNeedsProviderModelOverride("firerouter"), true);
    } finally {
      clearModelsDevFireworksRegistry();
    }
  });

  it("keeps overriding router aliases while the registry is unavailable", () => {
    clearModelsDevFireworksRegistry();
    assert.equal(opencodeNeedsProviderModelOverride("glm-latest"), true);
  });

  it("on selects the models.dev row and drops a stale duplicate override", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-dedupe-"));
    const configPath = path.join(home, "opencode.json");
    const enable = (extra) => enableOpencodeFireworks({
      configPath,
      dataDir: path.join(home, "data"),
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      catalogModelIds: [GLM_LATEST, KIMI_LATEST],
      ...extra,
    });
    try {
      await enable({ modelId: "glm-latest" });
      let config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.model, "fireworks-ai/glm-latest");
      assert.ok(config.provider["fireworks-ai"].models["glm-latest"]);

      setModelsDevFireworksRegistry([GLM_LATEST]);
      const result = await enable({});
      config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.model, `fireworks-ai/${GLM_LATEST}`);
      assert.deepEqual(Object.keys(config.provider["fireworks-ai"].models).sort(), ["kimi-latest"]);
      assert.equal(result.modelsAdded.includes("glm-latest"), false);
    } finally {
      clearModelsDevFireworksRegistry();
      await rm(home, { recursive: true, force: true });
    }
  });
});
