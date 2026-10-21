import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolatedChildHome, seedOnCommandCatalog } from "../../helpers.mjs";

import {
  OPENCODE_AZURE_PROVIDER_ID,
  OPENCODE_FIREWORKS_PROVIDER_ID,
  opencodeConfigPath,
} from "../../../lib/harnesses/opencode/core.mjs";

const CLI = path.join(import.meta.dirname, "..", "..", "..", "bin", "nexus.mjs");
const AZURE_ENDPOINT = "https://my-res.services.ai.azure.com";
const AZURE_BASE_URL = "https://my-res.services.ai.azure.com/openai/v1";
const AZURE_KEY = "azure-test-key-1234567890";

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    if (args.includes("on")) { seedOnCommandCatalog(env.HOME, args); }
    const child = spawn(process.execPath, [CLI, ...args], {
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
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-oc-azure-"));
  try {
    await mkdir(path.join(home, ".config/opencode"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("opencode azure harness", () => {
  it("writes a Foundry provider block with a literal key (--api-key)", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      const original = JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n";
      await writeFile(configPath, original);

      const result = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      const provider = config.provider[OPENCODE_AZURE_PROVIDER_ID];
      assert.ok(provider, "azure provider should exist");
      assert.equal(provider.npm, "@ai-sdk/openai-compatible");
      assert.equal(provider.options.baseURL, AZURE_BASE_URL);
      assert.equal(provider.options.apiKey, AZURE_KEY);
      assert.equal(config.model, `${OPENCODE_AZURE_PROVIDER_ID}/FW-GLM-5.2`);
      assert.deepEqual(provider.models["FW-GLM-5.2"].limit, {
        context: 1_048_575,
        output: 131_072,
      });
      assert.equal(config.provider[OPENCODE_FIREWORKS_PROVIDER_ID], undefined);

      // A literal key is stored in opencode.json, so it must be owner-only (0600):
      // no group/other access bits.
      const st = await stat(configPath);
      assert.equal(st.mode & 0o077, 0o000, "opencode.json should be owner-only (0600) with a literal key");
    });
  });

  it("normalizes a portal project endpoint and honors --model", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      await writeFile(configPath, JSON.stringify({}, null, 2) + "\n");

      const result = await runFireconnect(
        [
          "opencode", "on", "--azure",
          "--base-url", "https://r.services.ai.azure.com/api/projects/msft-fw-foundry",
          "--api-key", AZURE_KEY,
          "--model", "FW-MiniMax-M2.5",
        ],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      const provider = config.provider[OPENCODE_AZURE_PROVIDER_ID];
      assert.equal(provider.options.baseURL, "https://r.services.ai.azure.com/openai/v1");
      assert.equal(config.model, `${OPENCODE_AZURE_PROVIDER_ID}/FW-MiniMax-M2.5`);
      assert.equal(provider.models["FW-MiniMax-M2.5"].limit.context, 196_608);
    });
  });

  it("uses {env:AZURE_API_KEY} when the key comes from the environment", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      await writeFile(configPath, JSON.stringify({}, null, 2) + "\n");

      const result = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: AZURE_KEY },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(
        config.provider[OPENCODE_AZURE_PROVIDER_ID].options.apiKey,
        "{env:AZURE_API_KEY}",
      );
      // Env-reference mode stores no secret on disk, so opencode.json must NOT
      // be locked to owner-only — it keeps the tool's default (group/other read).
      const st = await stat(configPath);
      assert.notEqual(st.mode & 0o077, 0o000, "env-reference opencode.json should keep default perms");

      const status = await runFireconnect(["opencode", "status"], { HOME: home });
      assert.equal(status.code, 0, status.stderr);
      assert.match(status.stdout, /Auth: environment reference in config/);
    });
  });

  it("fails without a base URL", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      await writeFile(configPath, JSON.stringify({}, null, 2) + "\n");

      const result = await runFireconnect(
        ["opencode", "on", "--azure", "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Azure endpoint/);
    });
  });

  it("re-on without --base-url reuses the stored endpoint and applies --model", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      assert.equal(
        (await runFireconnect(
          ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );

      // Re-on with only --model (no --base-url, no global configure).
      const reon = await runFireconnect(
        ["opencode", "on", "--azure", "--model", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(reon.code, 0, reon.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.provider[OPENCODE_AZURE_PROVIDER_ID].options.baseURL, AZURE_BASE_URL);
      assert.equal(config.provider[OPENCODE_AZURE_PROVIDER_ID].options.apiKey, AZURE_KEY);
      assert.equal(config.model, `${OPENCODE_AZURE_PROVIDER_ID}/FW-MiniMax-M2.5`);
    });
  });

  it("rejects a reused {env:AZURE_API_KEY} reference when AZURE_API_KEY is unset", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      // First on with the env var set stores the {env:AZURE_API_KEY} reference.
      const first = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: AZURE_KEY },
      );
      assert.equal(first.code, 0, first.stderr);
      const stored = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(stored.provider[OPENCODE_AZURE_PROVIDER_ID].options.apiKey, "{env:AZURE_API_KEY}");

      // Re-on with the env var unset must fail rather than write a dead ref.
      const second = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: "" },
      );
      assert.notEqual(second.code, 0);
      assert.match(second.stderr, /No Azure API key/);
    });
  });

  it("on/off round-trip restores the original config byte-for-byte", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      const original = JSON.stringify(
        { model: "openai/gpt-4", provider: { openai: { options: { apiKey: "sk-x" } } } },
        null,
        2,
      ) + "\n";
      await writeFile(configPath, original);

      const on = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(on.code, 0, on.stderr);

      const off = await runFireconnect(["opencode", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);

      const restored = await readFile(configPath, "utf8");
      assert.equal(restored, original);
    });
  });

  it("status reports the azure provider and endpoint", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      await writeFile(configPath, JSON.stringify({}, null, 2) + "\n");

      await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );

      const status = await runFireconnect(["opencode", "status", "--json"], { HOME: home });
      assert.equal(status.code, 0, status.stderr);
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.provider, "azure");
      assert.equal(payload.baseUrl, AZURE_BASE_URL);
      assert.equal(payload.hasAuthToken, true);
      assert.equal(payload.current.main, "FW-GLM-5.2");

      const human = await runFireconnect(["opencode", "status"], { HOME: home });
      assert.equal(human.code, 0, human.stderr);
      assert.match(human.stdout, /Auth: stored in config/);
    });
  });

  it("switching from Fireworks to Azure replaces the provider and preserves the original backup", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      const original = JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n";
      await writeFile(configPath, original);

      const fwOn = await runFireconnect(
        ["opencode", "on", "--api-key", "fw_test_key_12345"],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(fwOn.code, 0, fwOn.stderr);

      const azOn = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(azOn.code, 0, azOn.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.ok(config.provider[OPENCODE_AZURE_PROVIDER_ID]);
      assert.equal(config.provider[OPENCODE_FIREWORKS_PROVIDER_ID], undefined);

      const off = await runFireconnect(["opencode", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);
      const restored = await readFile(configPath, "utf8");
      assert.equal(restored, original);
    });
  });

  it("direct -> Azure -> direct -> off preserves the original backup", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      const original = JSON.stringify({
        model: "user/model",
        provider: { user: { options: { baseURL: "https://example.invalid" } } },
      }) + "\n";
      await writeFile(configPath, original);

      const firerouter = await runFireconnect(
        [
          "opencode", "on",
          "--api-key", "fw_test_key_12345",
        ],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(firerouter.code, 0, firerouter.stderr);

      const azure = await runFireconnect(
        [
          "opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT,
          "--api-key", AZURE_KEY,
        ],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(azure.code, 0, azure.stderr);

      const direct = await runFireconnect(
        ["opencode", "on", "--api-key", "fw_test_key_12345"],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(direct.code, 0, direct.stderr);
      const active = JSON.parse(await readFile(configPath, "utf8"));
      assert.ok(active.provider[OPENCODE_FIREWORKS_PROVIDER_ID]);
      assert.equal(active.provider[OPENCODE_AZURE_PROVIDER_ID], undefined);

      const off = await runFireconnect(
        ["opencode", "off"],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(off.code, 0, off.stderr);
      assert.equal(await readFile(configPath, "utf8"), original);
    });
  });
});
