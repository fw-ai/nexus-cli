import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PI_AZURE_PROVIDER, piSettingsPath, piModelsPath } from "../../../lib/harnesses/pi/core.mjs";
import { lookupAzureFoundryModelLimits } from "../../../lib/fireworks/azure-core.mjs";
import { harnessTestArgs, isolatedChildHome, seedOnCommandCatalog } from "../../helpers.mjs";

const CLI = path.join(import.meta.dirname, "..", "..", "..", "bin", "nexus.mjs");
const AZURE_ENDPOINT = "https://msft-fw-foundry-resource.services.ai.azure.com";
const AZURE_BASE_URL = "https://msft-fw-foundry-resource.services.ai.azure.com/openai/v1";
const AZURE_KEY = "azure-test-key-1234567890";

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    if (args.includes("on")) { seedOnCommandCatalog(env.HOME, args); }
    const child = spawn(process.execPath, [CLI, ...harnessTestArgs(args)], {
      env: { ...process.env, FIREWORKS_API_KEY: "", AZURE_API_KEY: "", NEXUS_SECRET_STORE: "memory", NEXUS_TEST: "1", ...env, HOME: isolatedChildHome(env) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-azure-"));
  try {
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("pi azure harness", () => {
  it("does not reuse stale Azure credentials while Pi is on Fireworks", async () => {
    await withHome(async (home) => {
      await writeFile(piSettingsPath(home), JSON.stringify({
        defaultProvider: "fireworks",
        defaultModel: "accounts/fireworks/routers/glm-fast-latest",
      }));
      await writeFile(piModelsPath(home), JSON.stringify({
        providers: {
          [PI_AZURE_PROVIDER]: {
            baseUrl: AZURE_BASE_URL,
            apiKey: "stale-azure-key",
          },
        },
      }));

      const noKey = await runFireconnect(["pi", "on", "--azure"], { HOME: home });
      assert.notEqual(noKey.code, 0);
      assert.match(noKey.stderr, /No Azure API key/);

      const noEndpoint = await runFireconnect(
        ["pi", "on", "--azure", "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.notEqual(noEndpoint.code, 0);
      assert.match(noEndpoint.stderr, /No Azure endpoint/);
    });
  });

  it("registers a custom openai-completions provider with a literal key (--api-key)", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--model", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);

      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultProvider, PI_AZURE_PROVIDER);
      assert.equal(settings.defaultModel, "FW-MiniMax-M2.5");

      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      const provider = models.providers[PI_AZURE_PROVIDER];
      assert.equal(provider.api, "openai-completions");
      assert.equal(provider.baseUrl, AZURE_BASE_URL);
      assert.equal(provider.authHeader, true);
      assert.equal(provider.apiKey, AZURE_KEY);
      assert.deepEqual(provider.models, [{
        id: "FW-MiniMax-M2.5",
        input: ["text"],
        contextWindow: 196_608,
        maxTokens: 24_576,
      }]);

      // A literal key is stored in models.json, so it must be owner-only (0600):
      // no group/other access bits.
      const st = await stat(piModelsPath(home));
      assert.equal(st.mode & 0o077, 0o000, "models.json should be owner-only (0600) with a literal key");
    });
  });

  it("switching from Fireworks to Azure clears the stale Fireworks enabledModels scope", async () => {
    await withHome(async (home) => {
      // Seed a Fireworks-on config, including the router-only picker scope
      // Nexus writes on a Fireworks `on`.
      await writeFile(piSettingsPath(home), JSON.stringify({
        defaultProvider: "fireworks",
        defaultModel: "accounts/fireworks/routers/kimi-fast-latest",
        enabledModels: ["fireworks/accounts/fireworks/routers/*"],
      }));
      await writeFile(piModelsPath(home), JSON.stringify({
        providers: { fireworks: { models: [{ id: "accounts/fireworks/routers/kimi-fast-latest" }] } },
      }));

      const result = await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--model", "FW-GLM-5.2"],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);

      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultProvider, PI_AZURE_PROVIDER);
      // Azure is unscaffolded — a stale Fireworks enabledModels must be dropped so
      // the picker isn't scoped to Fireworks routers (no auth in Azure mode).
      assert.equal(settings.enabledModels, undefined, "stale Fireworks enabledModels cleared on Azure switch");
    });
  });

  it("normalizes a portal project endpoint and defaults the model", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        [
          "pi", "on", "--azure",
          "--base-url", "https://r.services.ai.azure.com/api/projects/p",
          "--api-key", AZURE_KEY,
        ],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers[PI_AZURE_PROVIDER].baseUrl, "https://r.services.ai.azure.com/openai/v1");
      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultModel, "FW-GLM-5.2");
    });
  });

  it("uses $AZURE_API_KEY when the key comes from the environment", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: AZURE_KEY },
      );
      assert.equal(result.code, 0, result.stderr);
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers[PI_AZURE_PROVIDER].apiKey, "$AZURE_API_KEY");
      const human = await runFireconnect(["pi", "status"], { HOME: home, AZURE_API_KEY: AZURE_KEY });
      assert.equal(human.code, 0, human.stderr);
      assert.match(human.stdout, /Auth: environment reference in config/);
      // Env-reference mode stores no secret on disk, so models.json must NOT be
      // locked to owner-only — it keeps the tool's default (group/other read).
      const st = await stat(piModelsPath(home));
      assert.notEqual(st.mode & 0o077, 0o000, "env-reference models.json should keep default perms");
    });
  });

  it("fails without a base URL", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["pi", "on", "--azure", "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Azure endpoint/);
    });
  });

  it("on/off round-trip restores the original settings and models byte-for-byte", async () => {
    await withHome(async (home) => {
      const settingsPath = piSettingsPath(home);
      const modelsPath = piModelsPath(home);
      const originalSettings = JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude" }, null, 2) + "\n";
      const originalModels = JSON.stringify({ providers: { ollama: { baseUrl: "http://x/v1", api: "openai-completions" } } }, null, 2) + "\n";
      await writeFile(settingsPath, originalSettings);
      await writeFile(modelsPath, originalModels);

      const on = await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(on.code, 0, on.stderr);

      const off = await runFireconnect(["pi", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);

      assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
      assert.equal(await readFile(modelsPath, "utf8"), originalModels);
    });
  });

  it("re-on without --base-url reuses the stored endpoint and applies --model", async () => {
    await withHome(async (home) => {
      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );

      const reon = await runFireconnect(
        ["pi", "on", "--azure", "--model", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(reon.code, 0, reon.stderr);

      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultModel, "FW-MiniMax-M2.5");
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers[PI_AZURE_PROVIDER].baseUrl, AZURE_BASE_URL);
    });
  });

  it("status hasAuthToken reflects the AZURE_API_KEY env var for env-referenced keys", async () => {
    await withHome(async (home) => {
      // Store the $AZURE_API_KEY reference (env-mode on).
      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT],
          { HOME: home, AZURE_API_KEY: AZURE_KEY },
        )).code,
        0,
      );

      const withEnv = await runFireconnect(["pi", "status", "--json"], { HOME: home, AZURE_API_KEY: AZURE_KEY });
      assert.equal(JSON.parse(withEnv.stdout).hasAuthToken, true);

      const withoutEnv = await runFireconnect(["pi", "status", "--json"], { HOME: home, AZURE_API_KEY: "" });
      assert.equal(JSON.parse(withoutEnv.stdout).hasAuthToken, false);
    });
  });

  it("switching from Azure to the Fireworks gateway drops the fireworks-azure provider", async () => {
    await withHome(async (home) => {
      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );
      const fw = await runFireconnect(
        ["pi", "on", "--api-key", "fw_test_key_12345"],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(fw.code, 0, fw.stderr);

      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers[PI_AZURE_PROVIDER], undefined);
    });
  });

  it("azure on -> fireworks on -> off restores the original config byte-for-byte", async () => {
    await withHome(async (home) => {
      const settingsPath = piSettingsPath(home);
      const modelsPath = piModelsPath(home);
      const origSettings = JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude" }, null, 2) + "\n";
      const origModels = JSON.stringify(
        { providers: { ollama: { baseUrl: "http://x/v1", api: "openai-completions" } } },
        null,
        2,
      ) + "\n";
      await writeFile(settingsPath, origSettings);
      await writeFile(modelsPath, origModels);

      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );
      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--api-key", "fw_test_key_12345"],
          { HOME: home, FIREWORKS_API_KEY: "" },
        )).code,
        0,
      );
      assert.equal((await runFireconnect(["pi", "off"], { HOME: home })).code, 0);

      // off must restore the genuine pre-Nexus config, not the Azure state.
      assert.equal(await readFile(settingsPath, "utf8"), origSettings);
      assert.equal(await readFile(modelsPath, "utf8"), origModels);
    });
  });

  it("sets contextWindow from Fireworks specs for Foundry GLM deployments", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--model", "FW-GLM-5.2"],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      const limits = lookupAzureFoundryModelLimits("FW-GLM-5.2");
      assert.equal(models.providers[PI_AZURE_PROVIDER].models[0].contextWindow, limits.contextWindow);
      assert.equal(models.providers[PI_AZURE_PROVIDER].models[0].maxTokens, limits.maxTokens);
      assert.deepEqual(models.providers[PI_AZURE_PROVIDER].models[0].input, ["text"]);
    });
  });

  it("sets image input for vision-capable Foundry deployments", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--model", "FW-Kimi-K2.7-Code"],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.deepEqual(models.providers[PI_AZURE_PROVIDER].models[0].input, ["text", "image"]);
    });
  });

  it("status reports the azure provider and endpoint", async () => {
    await withHome(async (home) => {
      await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      const status = await runFireconnect(["pi", "status", "--json"], { HOME: home });
      assert.equal(status.code, 0, status.stderr);
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.provider, "azure");
      assert.equal(payload.baseUrl, AZURE_BASE_URL);
      assert.equal(payload.defaultProvider, PI_AZURE_PROVIDER);
      assert.equal(payload.hasAuthToken, true);
      assert.equal(payload.current.main, "FW-GLM-5.2");

      const human = await runFireconnect(["pi", "status"], { HOME: home });
      assert.equal(human.code, 0, human.stderr);
      assert.match(human.stdout, /Auth: stored in config/);
    });
  });
});
