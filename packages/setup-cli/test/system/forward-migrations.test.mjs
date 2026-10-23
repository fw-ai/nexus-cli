import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { FIREWORKS_BASE_URL } from "../../lib/fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../lib/io/json.mjs";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import { codexCatalogPath, codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piModelsPath, piSettingsPath } from "../../lib/harnesses/pi/core.mjs";
import { chatLanguageModelsPath } from "../../lib/harnesses/vscode/core.mjs";
import { copilotCliPathsFor } from "../../lib/harness/context.mjs";
import { ensureAutoCatalogEntry } from "../../lib/harness/auto-catalog.mjs";
import { migrateRetiredRoutingPreferenceNotes, runHarnessForwardMigrations } from "../../lib/system/forward-migrations.mjs";
import { warmTestCatalogSnapshot, withTempHome } from "../helpers.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  clearModelsDevFireworksRegistry,
  setModelsDevFireworksRegistry,
} from "../../lib/fireworks/models-dev-registry.mjs";

describe("runHarnessForwardMigrations", () => {
  before(() => {
    warmTestCatalogSnapshot();
  });

  after(() => {
    setServerlessCatalogSnapshot(null);
  });

  it("backfills ENABLE_TOOL_SEARCH for an enabled Claude and reports a note", async () => {
    await withTempHome("forward-migrate-claude-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({
          env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
        }, null, 2)}\n`,
        { mode: 0o600 },
      );

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /ENABLE_TOOL_SEARCH/.test(n)).length, 1, notes.join("\n"));
      assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).env.ENABLE_TOOL_SEARCH, "true");
    });
  });

  it("removes a retired CLAUDE_CODE_AUTO_MODE_SERVER=0 pin for an enabled Claude and reports a note", async () => {
    await withTempHome("forward-migrate-claude-ams-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
            ENABLE_TOOL_SEARCH: "true",
            CLAUDE_CODE_AUTO_MODE_SERVER: "0",
          },
        }, null, 2)}\n`,
        { mode: 0o600 },
      );

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /CLAUDE_CODE_AUTO_MODE_SERVER/.test(n)).length, 1, notes.join("\n"));
      const { env } = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(Object.hasOwn(env, "CLAUDE_CODE_AUTO_MODE_SERVER"), false);
    });
  });

  it("does not touch Claude settings when the harness is off", async () => {
    await withTempHome("forward-migrate-claude-off-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: false, provider: "fireworks" } },
      });
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      const original = `${JSON.stringify({
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      }, null, 2)}\n`;
      await writeFile(settingsPath, original, { mode: 0o600 });

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /ENABLE_TOOL_SEARCH/.test(n)).length, 0, notes.join("\n"));
      assert.equal(await readFile(settingsPath, "utf8"), original);
    });
  });

  it("removes the stale Codex web_search override for an enabled harness", async () => {
    await withTempHome("forward-migrate-codex-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { codex: { enabled: true, provider: "fireworks" } },
      });
      const configPath = codexConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        'model_provider = "fireworks-ai"',
        'model = "glm-5p1"',
        'web_search = "disabled"',
        "",
        "[model_providers.fireworks-ai]",
        'base_url = "https://api.fireworks.ai/inference/v1"',
        'experimental_bearer_token = "fw_test_key"',
        "",
      ].join("\n"), { mode: 0o600 });

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /Codex web search/.test(n)).length, 1, notes.join("\n"));
      assert.doesNotMatch(await readFile(configPath, "utf8"), /^web_search\s*=/m);
    });
  });

  it("preserves a user-set Codex web_search value", async () => {
    await withTempHome("forward-migrate-codex-user-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { codex: { enabled: true, provider: "fireworks" } },
      });
      const configPath = codexConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      const original = [
        'model_provider = "fireworks-ai"',
        'model = "glm-5p1"',
        'web_search = "live"',
        "",
        "[model_providers.fireworks-ai]",
        'base_url = "https://api.fireworks.ai/inference/v1"',
        'experimental_bearer_token = "fw_test_key"',
      ].join("\n");
      await writeFile(configPath, original, { mode: 0o600 });

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /Codex web search/.test(n)).length, 0, notes.join("\n"));
      const migrated = await readFile(configPath, "utf8");
      assert.match(migrated, /^web_search = "live"$/m);
      // No catalog file exists, so the auto backfill leaves the config alone
      // (a fresh offline `on` writes no catalog either).
      assert.doesNotMatch(migrated, /model_catalog_json/);
    });
  });

  it("adds auto only to an existing referenced Codex catalog", async () => {
    await withTempHome("forward-migrate-codex-auto-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { codex: { enabled: true, provider: "fireworks" } },
      });
      const configPath = codexConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      const managed = (ref) => [
        'model_provider = "fireworks-ai"',
        'model = "glm-5p1"',
        ...(ref ? ['model_catalog_json = "~/.codex/fireworks-model-catalog.json"'] : []),
        "",
        "[model_providers.fireworks-ai]",
        'base_url = "https://api.fireworks.ai/inference/v1"',
        'experimental_bearer_token = "fw_test_key"',
      ].join("\n");
      const catalogPath = codexCatalogPath(home);

      // Referenced catalog without auto: auto row prepended, ref untouched.
      await writeFile(configPath, managed(true), { mode: 0o600 });
      await writeJson(catalogPath, { models: [{ slug: "glm-5p1" }] });
      const noted = await runHarnessForwardMigrations(home);
      assert.equal(noted.filter((n) => /auto model to Codex/.test(n)).length, 1, noted.join("\n"));
      assert.deepEqual(
        (await readJsonIfExists(catalogPath)).models.map((row) => row.slug),
        ["auto", "glm-5p1"],
      );

      // No catalog file at all: nothing created, config untouched.
      await rm(catalogPath, { force: true });
      const before = await readFile(configPath, "utf8");
      const silent = await runHarnessForwardMigrations(home);
      assert.equal(silent.filter((n) => /auto model to Codex/.test(n)).length, 0, silent.join("\n"));
      assert.equal(await readFile(configPath, "utf8"), before);
      assert.equal(existsSync(catalogPath), false);
    });
  });

  it("reports a failed migration without skipping finalize", async () => {
    await withTempHome("forward-migrate-failure-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, "{invalid json");

      const notes = await runHarnessForwardMigrations(home);
      assert.ok(
        notes.includes("Couldn't enable MCP tool search for Claude Code — re-run nexus claude on."),
        notes.join("\n"),
      );
    });
  });

  it("reports a corrupt managed config instead of silently skipping it", async () => {
    await withTempHome("forward-migrate-corrupt-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, "{invalid json");

      const notes = await runHarnessForwardMigrations(home);
      assert.ok(
        notes.includes("Couldn't add the auto model to OpenCode — re-run nexus opencode on."),
        notes.join("\n"),
      );
    });
  });

  it("adds auto to OpenCode and Pi catalogs with one note each", async () => {
    await withTempHome("forward-migrate-auto-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: {
          opencode: { enabled: true, provider: "fireworks" },
          pi: { enabled: true, provider: "fireworks", profiles: { managedModelIds: [] } },
        },
      });
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({
          model: "fireworks-ai/glm-latest",
          provider: {
            "fireworks-ai": {
              options: { apiKey: "fw_test_key_12345" },
              models: { "glm-latest": { name: "GLM Latest" } },
            },
          },
        })}\n`,
      );
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await writeFile(
        piSettingsPath(home),
        `${JSON.stringify({
          defaultProvider: "fireworks",
          defaultModel: "accounts/fireworks/routers/glm-latest",
          enabledModels: ["fireworks/accounts/fireworks/routers/*"],
        })}\n`,
      );
      await writeFile(
        path.join(home, ".pi/agent", "auth.json"),
        `${JSON.stringify({ fireworks: { type: "api_key", key: "fw_test_key_12345", managedBy: "fireconnect" } })}\n`,
      );
      await writeFile(
        piModelsPath(home),
        `${JSON.stringify({ providers: { fireworks: { models: [{ id: "accounts/fireworks/routers/glm-latest" }] } } })}\n`,
      );

      const notes = await runHarnessForwardMigrations(home);
      assert.deepEqual(
        notes.filter((n) => /auto model to/.test(n)),
        ["Added the auto model to OpenCode — restart it to pick it up."],
        notes.join("\n"),
      );
      const opencode = JSON.parse(await readFile(configPath, "utf8"));
      assert.ok(opencode.provider["fireworks-ai"].models.auto);
      // The Pi upgrade step rewrites its fireworks provider, which includes auto.
      assert.ok(notes.some((n) => /^Updated Pi.s Fireworks models/.test(n)), notes.join("\n"));
      const piModels = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.deepEqual(piModels.providers.fireworks.models.map((m) => m.id), ["auto"]);
    });
  });

  it("moves an OpenCode FireRouter selection to auto on upgrade", async () => {
    await withTempHome("forward-migrate-opencode-firerouter-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({
          model: "fireworks-ai/firerouter/opus",
          provider: {
            "fireworks-ai": {
              options: {
                apiKey: "fw_test_key_12345",
                headers: { "x-anthropic-api-key": "sk-ant-legacy", "x-openai-api-key": "sk-proj-legacy", "X-User-Trace": "keep" },
              },
              models: { "firerouter/opus": { name: "FireRouter" }, "auto-instant": { name: "Auto Instant" }, "kimi-latest": { name: "Kimi" } },
            },
          },
        })}\n`,
      );

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /FireRouter is now Nexus Auto: moved OpenCode to `auto`/.test(n)).length, 1, notes.join("\n"));
      const migrated = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(migrated.model, "fireworks-ai/auto");
      // The FireRouter picker row goes with the selection; provider-key
      // headers stay for Nexus Auto.
      // (the `auto` row is the upgrade's own auto backfill).
      assert.deepEqual(Object.keys(migrated.provider["fireworks-ai"].models).sort(), ["auto", "kimi-latest"]);
      assert.deepEqual(migrated.provider["fireworks-ai"].options.headers, {
        "x-anthropic-api-key": "sk-ant-legacy",
        "x-openai-api-key": "sk-proj-legacy",
        "X-User-Trace": "keep",
      });

      const again = await runHarnessForwardMigrations(home);
      assert.equal(again.filter((n) => /FireRouter is now Nexus Auto: moved OpenCode to `auto`/.test(n)).length, 0, again.join("\n"));
    });
  });

  it("moves an OpenCode selection with the legacy fireworks/ prefix to auto on upgrade", async () => {
    await withTempHome("forward-migrate-opencode-legacy-prefix-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({
          model: "fireworks/firerouter/opus",
          provider: {
            "fireworks-ai": {
              options: { apiKey: "fw_test_key_12345" },
              models: { "firerouter/opus": { name: "FireRouter" } },
            },
          },
        })}\n`,
      );

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /FireRouter is now Nexus Auto: moved OpenCode to `auto`/.test(n)).length, 1, notes.join("\n"));
      assert.equal(JSON.parse(await readFile(configPath, "utf8")).model, "fireworks-ai/auto");
    });
  });

  it("moves a Copilot CLI FireRouter selection to auto on upgrade", async () => {
    await withTempHome("forward-migrate-copilot-cli-firerouter-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { "copilot-cli": { enabled: true, provider: "fireworks" } },
      });
      const { providersPath, settingsPath } = copilotCliPathsFor({ home });
      await mkdir(path.dirname(providersPath), { recursive: true });
      await writeJson(providersPath, {
        providers: [{ name: "fireworks", apiKey: "fw_test_key_12345" }],
        models: [
          { id: "firerouter", provider: "fireworks", wireModel: "firerouter", name: "FireRouter" },
          { id: "auto-instant", provider: "fireworks", wireModel: "auto-instant", name: "Auto Instant" },
          { id: "glm-latest", provider: "fireworks", wireModel: "glm-latest", name: "GLM" },
        ],
      });
      await writeJson(settingsPath, { model: "fireworks/firerouter" });

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /FireRouter is now Nexus Auto: moved the Copilot CLI to `auto`/.test(n)).length, 1, notes.join("\n"));
      assert.equal((await readJsonIfExists(settingsPath)).model, "fireworks/auto");
      const ids = (await readJsonIfExists(providersPath)).models.map((model) => model.id);
      assert.ok(!ids.includes("firerouter"), ids.join(","));
      assert.ok(!ids.includes("auto-instant"), ids.join(","));
      assert.ok(ids.includes("auto"), "the upgrade auto backfill registers the new selection");
    });
  });

  it("mirrors a pre-upgrade OpenCode provider into an existing v2 providers map", async () => {
    await withTempHome("forward-migrate-opencode-v2-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({
          model: "fireworks-ai/auto",
          provider: {
            "fireworks-ai": {
              options: { apiKey: "fw_test_key_12345" },
              models: { auto: { name: "Auto", modalities: { input: ["text", "image"] } } },
            },
          },
          providers: { "fireworks-ai": { settings: { apiKey: "fw_test_key_12345" } } },
        })}\n`,
      );

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /OpenCode v2/.test(n)).length, 1, notes.join("\n"));
      const native = JSON.parse(await readFile(configPath, "utf8")).providers["fireworks-ai"];
      assert.deepEqual(native.models.auto, {
        name: "Auto",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      });

      const again = await runHarnessForwardMigrations(home);
      assert.equal(again.filter((n) => /OpenCode/.test(n)).length, 0, again.join("\n"));
    });
  });

  async function writeOpencodeUpgradeFixture(home, { enabled = true, config }) {
    await writeGlobalConfig(home, {
      harnesses: { opencode: { enabled, provider: "fireworks" } },
    });
    const configPath = opencodeConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = `${JSON.stringify(config)}\n`;
    await writeFile(configPath, original);
    return { configPath, original };
  }

  const managedOpencodeConfig = {
    model: "fireworks-ai/auto",
    provider: {
      "fireworks-ai": { options: { apiKey: "fw_test_key_12345" }, models: { auto: { name: "Auto" } } },
    },
  };

  it("leaves a v1-only OpenCode config alone on upgrade", async () => {
    await withTempHome("forward-migrate-opencode-v1-", async (home) => {
      const { configPath, original } = await writeOpencodeUpgradeFixture(home, { config: managedOpencodeConfig });
      await runHarnessForwardMigrations(home);
      assert.equal(await readFile(configPath, "utf8"), original);
    });
  });

  it("leaves a v2 OpenCode config alone on upgrade when the harness is off", async () => {
    await withTempHome("forward-migrate-opencode-off-", async (home) => {
      const { configPath, original } = await writeOpencodeUpgradeFixture(home, {
        enabled: false,
        config: { ...managedOpencodeConfig, providers: {} },
      });
      await runHarnessForwardMigrations(home);
      assert.equal(await readFile(configPath, "utf8"), original);
    });
  });

  it("keeps native v2 entries without a managed v1 counterpart on upgrade", async () => {
    await withTempHome("forward-migrate-opencode-native-", async (home) => {
      const native = { "fireworks-ai": { settings: { apiKey: "{env:MY_FW}" } } };
      const { configPath } = await writeOpencodeUpgradeFixture(home, {
        config: {
          model: "fireworks/glm-latest",
          provider: { fireworks: { options: { apiKey: "fw_test_key_12345" } } },
          providers: native,
        },
      });
      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /OpenCode v2/.test(n)).length, 0, notes.join("\n"));
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).providers, native);
    });
  });

  const pickerDuplicateConfig = {
    model: "fireworks-ai/glm-latest",
    provider: {
      "fireworks-ai": {
        options: { apiKey: "fw_test_key_12345" },
        models: {
          auto: { name: "Auto" },
          "glm-latest": { name: "GLM 5.3 (Latest)" },
          "kimi-latest": { name: "Kimi K3 (Latest)" },
        },
      },
    },
    providers: {},
  };

  it("removes OpenCode picker duplicates of models.dev routers on upgrade", async () => {
    setModelsDevFireworksRegistry(["accounts/fireworks/routers/glm-latest"]);
    try {
      await withTempHome("forward-migrate-opencode-dupes-", async (home) => {
        const { configPath } = await writeOpencodeUpgradeFixture(home, { config: pickerDuplicateConfig });

        const notes = await runHarnessForwardMigrations(home);
        assert.equal(notes.filter((n) => /duplicate Fireworks models/.test(n)).length, 1, notes.join("\n"));
        const config = JSON.parse(await readFile(configPath, "utf8"));
        assert.equal(config.model, "fireworks-ai/accounts/fireworks/routers/glm-latest");
        assert.deepEqual(Object.keys(config.provider["fireworks-ai"].models), ["auto", "kimi-latest"]);
        assert.deepEqual(Object.keys(config.providers["fireworks-ai"].models), ["auto", "kimi-latest"]);

        const again = await runHarnessForwardMigrations(home);
        assert.equal(again.filter((n) => /OpenCode/.test(n)).length, 0, again.join("\n"));
      });
    } finally {
      clearModelsDevFireworksRegistry();
    }
  });

  it("keeps OpenCode overrides on upgrade while models.dev is unavailable", async () => {
    clearModelsDevFireworksRegistry();
    await withTempHome("forward-migrate-opencode-offline-", async (home) => {
      const config = { ...pickerDuplicateConfig, providers: undefined };
      const { configPath, original } = await writeOpencodeUpgradeFixture(home, { config });
      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /duplicate Fireworks models/.test(n)).length, 0, notes.join("\n"));
      assert.equal(await readFile(configPath, "utf8"), original);
    });
  });

  it("leaves managed configs alone when their harnesses are off", async () => {
    await withTempHome("forward-migrate-auto-off-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: {
          opencode: { enabled: false, provider: "fireworks" },
          pi: { enabled: false, provider: "fireworks", profiles: { managedModelIds: [] } },
        },
      });
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      const original = `${JSON.stringify({
        model: "fireworks-ai/glm-latest",
        provider: {
          "fireworks-ai": {
            options: { apiKey: "fw_test_key_12345" },
            models: { "glm-latest": { name: "GLM Latest" } },
          },
        },
      })}\n`;
      await writeFile(configPath, original);
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      const settingsPath = piSettingsPath(home);
      const originalSettings = `${JSON.stringify({
        defaultProvider: "fireworks",
        defaultModel: "accounts/fireworks/routers/glm-latest",
        enabledModels: ["fireworks/accounts/fireworks/routers/*"],
      })}\n`;
      await writeFile(settingsPath, originalSettings);

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /auto model to/.test(n)).length, 0, notes.join("\n"));
      assert.equal(await readFile(configPath, "utf8"), original);
      assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    });
  });

  it("removes the deprecated routing-preference header from every enabled harness, keeping user headers", async () => {
    await withTempHome("forward-migrate-routing-preference-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: {
          claude: { enabled: true, provider: "fireworks" },
          opencode: { enabled: true, provider: "fireworks" },
          pi: { enabled: true, provider: "fireworks" },
          vscode: { enabled: false, provider: "fireworks" },
        },
      });
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeJson(settingsPath, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test\nx-routing-preference: 5\nX-User-Trace: keep",
        },
      });
      const opencodePath = opencodeConfigPath(home);
      await mkdir(path.dirname(opencodePath), { recursive: true });
      await writeJson(opencodePath, {
        provider: {
          "fireworks-ai": { options: { apiKey: "fw_test", headers: { "x-routing-preference": "5", "X-User-Trace": "keep" } } },
        },
      });
      const piPath = piModelsPath(home);
      await mkdir(path.dirname(piPath), { recursive: true });
      await writeJson(piPath, {
        providers: { fireworks: { headers: { "x-routing-preference": "5", "X-User-Trace": "keep" } } },
      });
      const vscodePath = chatLanguageModelsPath({ home });
      await mkdir(path.dirname(vscodePath), { recursive: true });
      const vscodeConfig = `${JSON.stringify([{
        name: "Fireworks",
        vendor: "customoai",
        apiKey: "${input:chat.lm.secret.fw-0123abcd}",
        models: [{ id: "firerouter", requestHeaders: { "x-routing-preference": "5" } }],
      }])}\n`;
      await writeFile(vscodePath, vscodeConfig);

      const notes = await runHarnessForwardMigrations(home);

      assert.ok(
        notes.includes(
          "Removed the deprecated routing preference from Claude Code, OpenCode and Pi: Nexus Auto "
            + "takes effort from your harness instead. Restart them to pick it up.",
        ),
        notes.join("\n"),
      );
      const claudeHeaders = (await readJsonIfExists(settingsPath)).env.ANTHROPIC_CUSTOM_HEADERS;
      assert.equal(claudeHeaders, "X-Fireworks-Api-Key: fw_test\nX-User-Trace: keep");
      const opencodeHeaders = (await readJsonIfExists(opencodePath)).provider["fireworks-ai"].options.headers;
      assert.deepEqual(opencodeHeaders, { "X-User-Trace": "keep" });
      assert.deepEqual((await readJsonIfExists(piPath)).providers.fireworks.headers, { "X-User-Trace": "keep" });
      // VS Code is off, so its config is left alone.
      assert.equal(await readFile(vscodePath, "utf8"), vscodeConfig);
    });
  });

  it("leaves an open VS Code alone and removes the routing-preference header once it is closed", async () => {
    await withTempHome("forward-migrate-routing-preference-vscode-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { vscode: { enabled: true, provider: "fireworks" } },
      });
      const vscodePath = chatLanguageModelsPath({ home });
      await mkdir(path.dirname(vscodePath), { recursive: true });
      const vscodeConfig = `${JSON.stringify([{
        name: "Fireworks",
        vendor: "customoai",
        apiKey: "${input:chat.lm.secret.fw-0123abcd}",
        models: [{ id: "firerouter", requestHeaders: { "x-routing-preference": "5", "X-User-Trace": "keep" } }],
      }])}\n`;
      await writeFile(vscodePath, vscodeConfig);

      const whileOpen = await migrateRetiredRoutingPreferenceNotes(home, { vscodeRunning: () => true });
      assert.deepEqual(whileOpen, [
        "Couldn't remove the deprecated routing preference from VS Code while it's open — quit VS Code, then re-run nexus update.",
      ]);
      assert.equal(await readFile(vscodePath, "utf8"), vscodeConfig);

      const afterQuit = await migrateRetiredRoutingPreferenceNotes(home, { vscodeRunning: () => false });
      assert.equal(afterQuit.length, 1);
      assert.match(afterQuit[0], /^Removed the deprecated routing preference from VS Code:/);
      const [provider] = JSON.parse(await readFile(vscodePath, "utf8"));
      assert.deepEqual(provider.models[0].requestHeaders, { "X-User-Trace": "keep" });
      assert.deepEqual(await migrateRetiredRoutingPreferenceNotes(home, { vscodeRunning: () => false }), []);
    });
  });

  it("says nothing about an open VS Code that never had the routing-preference header", async () => {
    await withTempHome("forward-migrate-routing-preference-vscode-clean-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { vscode: { enabled: true, provider: "fireworks" } },
      });
      const vscodePath = chatLanguageModelsPath({ home });
      await mkdir(path.dirname(vscodePath), { recursive: true });
      await writeFile(vscodePath, `${JSON.stringify([{
        name: "Fireworks",
        vendor: "customoai",
        apiKey: "${input:chat.lm.secret.fw-0123abcd}",
        models: [{ id: "firerouter", requestHeaders: { "X-User-Trace": "keep" } }],
      }])}\n`);
      assert.deepEqual(await migrateRetiredRoutingPreferenceNotes(home, { vscodeRunning: () => true }), []);
    });
  });

  it("keeps VS Code's request headers and Anthropic key when the auto backfill runs", async () => {
    await withTempHome("forward-migrate-vscode-auto-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { vscode: { enabled: true, provider: "fireworks" } },
      });
      const jsonPath = chatLanguageModelsPath({ home });
      await mkdir(path.dirname(jsonPath), { recursive: true });
      const firerouter = {
        id: "firerouter",
        name: "FireRouter",
        anthropic_api_key: "sk-ant-byok",
        requestHeaders: {
          "x-anthropic-api-key": "sk-ant-byok",
          "x-routing-preference": "5",
          "X-User-Trace": "keep",
        },
      };
      await writeFile(jsonPath, `${JSON.stringify([{
        name: "Fireworks",
        vendor: "customoai",
        apiKey: "${input:chat.lm.secret.fw-0123abcd}",
        models: [firerouter],
      }])}\n`);

      assert.equal(await ensureAutoCatalogEntry("vscode", home, { isRunning: () => false }), true);
      const [provider] = JSON.parse(await readFile(jsonPath, "utf8"));
      assert.deepEqual(provider.models.map((m) => m.id), ["auto", "firerouter"]);
      assert.deepEqual(provider.models[1], firerouter);
    });
  });
});
