import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { piSettingsPath, piAuthPath, piModelsPath, PI_API_KEY_ENV_REF, PI_DATA_RELATIVE_DIR, PI_AZURE_PROVIDER } from "../../../lib/harnesses/pi/core.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import {
  cacheServerlessCatalogSnapshot,
  setServerlessCatalogSnapshot,
} from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { FIRECONNECT_REFERER, mockServerlessModel, runFireconnect, seedServerlessCatalogCache } from "../../helpers.mjs";

const AZURE_ENDPOINT = "https://msft-fw-foundry-resource.services.ai.azure.com";
const AZURE_KEY = "azure-test-key-1234567890";
const USER_FIREWORKS_MODEL = {
  id: "accounts/fireworks/models/custom-user-model",
  name: "Custom user model",
};

// A realistic cached serverless catalog (latest routers), used to seed the
// on-disk cache so a spawned CLI's offline registration / `off` cleanup reads
// it instead of a hand-maintained router list.
const CACHED_ROUTER_ENTRIES = [
  "glm-latest",
  "glm-fast-latest",
  "kimi-latest",
  "kimi-fast-latest",
  "deepseek-flash-latest",
  "deepseek-pro-latest",
  "minimax-latest",
  "qwen-plus-latest",
].map((slug, index) => ({
  id: `accounts/fireworks/routers/${slug}`,
  shortId: slug,
  displayName: slug, // the picker name resolution isn't under test here
  kind: "serverless",
}));

// Flat `/v1/serverless/models` rows pairing the `-latest` aliases with their
// leaf bases so offline registration resolves the same limits/pricing the live
// catalog does. Under the refactor aliases exist only when a row reports them
// via `aliases`; there is no static alias table. context_length 1_048_575
// matches glm-5p2's curated spec (asserted below).
const GLM_ALIAS_CATALOG_ROWS = [
  mockServerlessModel({
    id: "accounts/fireworks/models/glm-5p2",
    context_length: 1_048_575,
    aliases: ["accounts/fireworks/routers/glm-latest"],
  }),
  mockServerlessModel({
    id: "accounts/fireworks/models/glm-5p2",
    serverless_mode: "fast",
    context_length: 1_048_575,
    usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
    aliases: ["accounts/fireworks/routers/glm-fast-latest"],
    pricing: [
      { sku: "LLM input tokens (uncached)", amount: "2.1" },
      { sku: "LLM input tokens (cached)", amount: "0.21" },
      { sku: "LLM output tokens", amount: "6.6" },
    ],
  }),
];

/** Persist a flat-row catalog to `home`'s scoped cache for a spawned CLI to read. */
function seedFlatCatalogCache(home, rows) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(rows));
  } finally {
    process.env.HOME = prevHome;
    // The persisted file is what spawned CLIs lazy-load; keep this process's
    // in-memory snapshot empty so it can't leak into unrelated tests.
    setServerlessCatalogSnapshot(null);
  }
}

describe("pi harness integration", () => {
  it("re-on preserves a canonical active model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-reon-model-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });

    const first = await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345", "--model", "deepseek-v4-flash"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);
    const settingsPath = piSettingsPath(home);
    const canonical = "accounts/fireworks/models/deepseek-v4-flash";
    assert.equal(
      JSON.parse(await readFile(settingsPath, "utf8")).defaultModel,
      canonical,
    );

    const second = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(second.code, 0, second.stderr);
    const after = JSON.parse(await readFile(settingsPath, "utf8")).defaultModel;
    assert.equal(after, canonical);
  });

  it("status reports Fireworks as provider and auto as model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-firerouter-status-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });

    const on = await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const status = await runFireconnect(["pi", "status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(status.code, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.provider, "fireworks");
    assert.equal(payload.current.main, "auto");
  });

  it("rejects --anthropic-api-key with a firerouter model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-firerouter-byok-flag-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const anthropicKey = "sk-ant-pi-firerouter-12345";

    const on = await runFireconnect(
      [
        "pi", "on",
        "--api-key", "fw_test_key_12345",
        "--model", "firerouter",
        "--anthropic-api-key", anthropicKey,
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
    );
    assert.notEqual(on.code, 0);
    assert.match(on.stderr, /is no longer supported/);
  });

  it("rejects --openai-api-key with a firerouter model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-firerouter-openai-flag-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const openaiKey = "sk-proj-pi-firerouter-12345";

    const on = await runFireconnect(
      [
        "pi", "on",
        "--api-key", "fw_test_key_12345",
        "--model", "firerouter",
        "--openai-api-key", openaiKey,
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
    );
    assert.notEqual(on.code, 0);
    assert.match(on.stderr, /is no longer supported/);
  });

  it("registers only Nexus-only rows, leaving catalog models to Pi's own catalog", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-catalog-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const originalModels = JSON.stringify({ providers: { ollama: { models: [{ id: "llama3" }] } } }, null, 2) + "\n";
    await writeFile(piModelsPath(home), originalModels);

    // A seeded catalog resolves offline, so the full set registers
    // deterministically.
    seedFlatCatalogCache(home, [
      ...GLM_ALIAS_CATALOG_ROWS,
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k3",
        display_name: "Kimi K3",
        aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
      }),
    ]);
    const onResult = await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    const fw = models.providers.fireworks;
    const ids = [
      ...(fw.models ?? []).map((m) => m.id),
      ...Object.keys(fw.modelOverrides ?? {}),
    ];
    // A catalog-id row would replace Pi's tuned row (api, compat,
    // thinkingLevelMap), so only the auto mix is registered.
    assert.deepEqual(ids, ["auto"]);


    const offResult = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    // off restores the pre-existing models.json byte-for-byte (fireworks gone).
    assert.equal(await readFile(piModelsPath(home), "utf8"), originalModels);
  });

  it("on/off round-trip restores settings and auth", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-"));
    const settingsDir = path.join(home, ".pi/agent");
    await mkdir(settingsDir, { recursive: true });
    seedFlatCatalogCache(home, GLM_ALIAS_CATALOG_ROWS);
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);
    const originalSettings = JSON.stringify({ defaultProvider: "openai" }, null, 2) + "\n";
    const originalAuth = JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2) + "\n";
    const originalModels = JSON.stringify({ providers: { ollama: { models: [{ id: "llama3" }] } } }, null, 2) + "\n";
    await writeFile(settingsPath, originalSettings);
    await writeFile(authPath, originalAuth);
    await writeFile(modelsPath, originalModels);

    const onResult = await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);

    const enabledSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabledSettings.defaultProvider, "fireworks");
    assert.equal(enabledSettings.defaultModel, "auto");
    assert.equal(enabledSettings.enabledModels, undefined, "no picker scope");

    const enabledModels = JSON.parse(await readFile(modelsPath, "utf8"));
    const fireworksModels = enabledModels.providers.fireworks.models;
    assert.deepEqual(fireworksModels.map((model) => model.id), ["auto"]);
    assert.equal(enabledModels.providers.fireworks.modelOverrides, undefined);
    assert.equal(enabledModels.providers.fireworks.compat, undefined);

    const enabledAuth = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(enabledAuth.fireworks.managedBy, "fireconnect");
    assert.equal(enabledAuth.fireworks.key, "fw_test_key_12345");

    const offResult = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restoredSettings = await readFile(settingsPath, "utf8");
    const restoredAuth = await readFile(authPath, "utf8");
    const restoredModels = await readFile(modelsPath, "utf8");
    assert.equal(restoredSettings, originalSettings);
    assert.equal(restoredAuth, originalAuth);
    assert.equal(restoredModels, originalModels);
  });

  it("keeps the user's own picker scope, adding only the fireworks provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-scope-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    await writeFile(settingsPath, `${JSON.stringify({ enabledModels: ["ollama/*"] }, null, 2)}\n`);
    const onResult = await runFireconnect(
      ["pi", "on", "--api-key", "fw_cataloged_v1_adversarial000000", "--model", "kimi-latest"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.defaultModel, "accounts/fireworks/routers/kimi-latest");
    assert.deepEqual(settings.enabledModels, ["ollama/*", "fireworks/**"]);

    const repeat = await runFireconnect(["pi", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(repeat.code, 0, repeat.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(settingsPath, "utf8")).enabledModels,
      ["ollama/*", "fireworks/**"],
    );

    await runFireconnect(["pi", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { enabledModels: ["ollama/*"] });
  });

  it("writes a literal key into auth.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-env-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const authPath = piAuthPath(home);

    const onResult = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);
    assert.match(onResult.stdout, /Pi → Fireworks · auto/);

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(auth.fireworks.key, "fw_test_key_12345");
    assert.equal(auth.fireworks.managedBy, "fireconnect");
  });

  it("second off after on/off round-trip leaves settings unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-double-off-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const originalSettings = JSON.stringify({ defaultProvider: "openai" }, null, 2) + "\n";
    const originalAuth = JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2) + "\n";
    await writeFile(settingsPath, originalSettings);
    await writeFile(authPath, originalAuth);

    await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    await runFireconnect(["pi", "off"], { HOME: home });

    const secondOff = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(secondOff.code, 0);
    assert.match(secondOff.stdout, /was not connected/);

    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
  });

  it("off removes models.json when it did not exist before on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-no-models-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    await writeFile(piSettingsPath(home), `${JSON.stringify({ defaultProvider: "openai" }, null, 2)}\n`);
    await runFireconnect(["pi", "on", "--api-key", "fw_test_key_12345"], { HOME: home, FIREWORKS_API_KEY: "" });
    await runFireconnect(["pi", "off"], { HOME: home });
    await assert.rejects(readFile(piModelsPath(home), "utf8"), { code: "ENOENT" });
  });

  it("on enables x-session-affinity on the rows Nexus registers, not provider-wide", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-session-affinity-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };

    const result = await runFireconnect(["pi", "on"], env);
    assert.equal(result.code, 0, result.stderr);

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    assert.equal(models.providers.fireworks.compat, undefined);
    assert.deepEqual(models.providers.fireworks.models[0].compat, { sendSessionAffinityHeaders: true });
  });

  it("owns providers.fireworks while on; off restores the original models.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-own-provider-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const ollama = { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "llama3" }] };
    await writeFile(piModelsPath(home), `${JSON.stringify({
      providers: {
        ollama,
        fireworks: {
          compat: { sendSessionAffinityHeaders: true },
          headers: { "x-routing-preference": "3", "User-Agent": "fireconnect/0.7.0" },
          models: [{ id: "accounts/fireworks/routers/retired-code-fast" }],
        },
      },
    }, null, 2)}\n`);
    const original = await readFile(piModelsPath(home), "utf8");
    const env = { HOME: home, FIREWORKS_API_KEY: "" };

    const on = await runFireconnect(["pi", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(on.code, 0, on.stderr);
    let models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    assert.deepEqual(models.providers.ollama, ollama);
    assert.deepEqual(models.providers.fireworks.models.map((model) => model.id), ["auto"]);
    assert.equal(models.providers.fireworks.compat, undefined);
    assert.equal(models.providers.fireworks.headers["X-Title"], "Pi");
    assert.equal(models.providers.fireworks.headers["x-routing-preference"], undefined);

    const azure = await runFireconnect(
      ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
      env,
    );
    assert.equal(azure.code, 0, azure.stderr);
    models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    assert.equal(models.providers.fireworks, undefined, "one Nexus provider at a time");
    assert.ok(models.providers[PI_AZURE_PROVIDER]);

    const off = await runFireconnect(["pi", "off"], env);
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(piModelsPath(home), "utf8"), original);
  });

  it("status reflects fireworks while enabled and default after off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-status-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    await writeFile(settingsPath, `${JSON.stringify({ defaultProvider: "openai" }, null, 2)}\n`);

    await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    const onStatus = await runFireconnect(["pi", "status", "--json"], { HOME: home });
    assert.equal(onStatus.code, 0);
    assert.match(onStatus.stdout, /"provider": "fireworks"/);

    await runFireconnect(["pi", "off"], { HOME: home });
    const offStatus = await runFireconnect(["pi", "status", "--json"], { HOME: home });
    assert.equal(offStatus.code, 0);
    assert.match(offStatus.stdout, /"provider": "default"/);
    assert.doesNotMatch(offStatus.stdout, /"defaultProvider": "fireworks"/);
  });

  it("re-on after data dir wipe still restores the pre-Nexus config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-wipe-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const env = { HOME: home, FIREWORKS_API_KEY: "" };

    await writeFile(settingsPath, `${JSON.stringify({ defaultProvider: "openai" }, null, 2)}\n`);
    await writeFile(authPath, `${JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2)}\n`);

    const originalSettings = await readFile(settingsPath, "utf8");
    const originalAuth = await readFile(authPath, "utf8");
    await runFireconnect(["pi", "on", "--api-key", "fw_test_key_12345"], env);

    await rm(path.join(home, PI_DATA_RELATIVE_DIR), { recursive: true, force: true });

    await runFireconnect(["pi", "on", "--api-key", "fw_test_key_12345"], env);
    await runFireconnect(["pi", "off"], env);

    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
  });

  it("on with --model of a catalog router selects it without writing a row over Pi's", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-glm-latest-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    seedFlatCatalogCache(home, GLM_ALIAS_CATALOG_ROWS);
    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };

    const result = await runFireconnect(["pi", "on", "--model", "glm-latest"], env);
    assert.equal(result.code, 0, result.stderr);

    const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
    assert.equal(settings.defaultModel, "accounts/fireworks/routers/glm-latest");
    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    assert.ok(!models.providers.fireworks.models.some(
      (model) => model.id === "accounts/fireworks/routers/glm-latest",
    ));
  });

});
