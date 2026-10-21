import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codexCatalogPath, codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { parseToml } from "../../lib/harnesses/codex/toml.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piModelsPath, piSettingsPath } from "../../lib/harnesses/pi/core.mjs";
import { isFireconnectProvider } from "../../lib/harnesses/vscode/core.mjs";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import {
  copilotProvidersPath,
  copilotSettingsPath,
} from "../../lib/harnesses/copilot-cli/config.mjs";
import {
  CURSOR_DEFAULT_MODE,
  cursorCurrentModelId,
} from "../../lib/harnesses/cursor/core.mjs";
import { shortFireworksModelRef } from "../../lib/fireworks/model-id.mjs";
import {
  itIfSqlite,
  mockServerlessModel,
  runCli,
  runFireconnect,
  seedServerlessCatalogCache,
  withTempHome,
} from "../helpers.mjs";

/**
 * Cross-harness contract for the shared fresh-install policy (see
 * lib/harness/catalog-refresh.mjs): a fresh `on --model <id>` seeds the
 * whole fetched catalog — `--model` selects the active model, it never
 * narrows the picker menu. Every registry harness pins the same expectation
 * here so the behavior can't drift per harness again.
 *
 * Seeds use `-latest` router aliases (not bare models) because some
 * registries only list ids that need provider overrides (OpenCode's
 * models.dev covers bare serverless models natively).
 */
function seedTwoRouterCatalog(home) {
  seedServerlessCatalogCache(home, [
    mockServerlessModel({
      id: "accounts/fireworks/models/alpha-base",
      display_name: "Alpha Base",
      aliases: ["accounts/fireworks/routers/alpha-latest"],
    }),
    mockServerlessModel({
      id: "accounts/fireworks/models/beta-base",
      display_name: "Beta Base",
      aliases: ["accounts/fireworks/routers/beta-latest"],
    }),
  ]);
}

const API_KEY_ARGS = ["on", "--api-key", "fw_test_key_12345", "--model", "alpha-latest"];

// Cursor's Electron-state key for the applicationUser blob (mirrors
// cursor-harness.test.mjs).
const CURSOR_APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

describe("fresh on --model seeds the full catalog in every harness", () => {
  it("claude registers both routers and pins the selection", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-contract-claude-"));
    seedTwoRouterCatalog(home);

    const result = await runFireconnect(["claude", ...API_KEY_ARGS], {
      HOME: home,
      FIREWORKS_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    });
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.model, "alpha-latest[1m]");
    const ids = settings.modelPicker.options.map((option) => option.model);
    assert.ok(ids.includes("alpha-latest[1m]"), `got ${ids.join(",")}`);
    assert.ok(ids.includes("beta-latest[1m]"), `got ${ids.join(",")}`);
    assert.equal(ids.length, new Set(ids).size, `duplicate rows: ${ids.join(",")}`);
  });

  it("codex writes both routers and pins the selection", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-contract-codex-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    seedTwoRouterCatalog(home);

    const result = await runFireconnect(["codex", ...API_KEY_ARGS], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(codexConfigPath(home), "utf8"), /model = "alpha-latest"/);
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8"))
      .models.map((row) => row.slug);
    assert.ok(slugs.includes("alpha-latest"), `got ${slugs.join(",")}`);
    assert.ok(slugs.includes("beta-latest"), `got ${slugs.join(",")}`);
    assert.equal(slugs.length, new Set(slugs).size, `duplicate rows: ${slugs.join(",")}`);
  });

  it("opencode registers both routers and pins the selection", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-contract-opencode-"));
    seedTwoRouterCatalog(home);

    const result = await runFireconnect(["opencode", ...API_KEY_ARGS], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
    assert.equal(config.model, "fireworks-ai/alpha-latest");
    const ids = Object.keys(config.provider["fireworks-ai"].models);
    assert.ok(ids.includes("alpha-latest"), `got ${ids.join(",")}`);
    assert.ok(ids.includes("beta-latest"), `got ${ids.join(",")}`);
  });

  it("pi pins the selection and leaves catalog rows to Pi's own catalog", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-contract-pi-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    seedTwoRouterCatalog(home);

    const result = await runFireconnect(["pi", ...API_KEY_ARGS], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      JSON.parse(await readFile(piSettingsPath(home), "utf8")).defaultModel,
      "accounts/fireworks/routers/alpha-latest",
    );
    const ids = JSON.parse(await readFile(piModelsPath(home), "utf8"))
      .providers.fireworks.models.map((model) => model.id);
    // A row with a catalog id would replace Pi's tuned row for it.
    assert.deepEqual(ids, ["auto"]);
  });

  itIfSqlite("vscode registers both routers", async () => {
    await withTempHome("fc-contract-vscode-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      seedTwoRouterCatalog(home);

      const result = await runCli(
        ["vscode", ...API_KEY_ARGS, "--vscode-path", vscodePath, "--force"],
        {
          home,
          env: { NEXUS_VSCODE_SECRET_PLAINTEXT: "1", FIREWORKS_API_KEY: "" },
        },
      );
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      const arr = JSON.parse(await readFile(vscodePath, "utf8"));
      const ids = arr.find(isFireconnectProvider).models.map((m) => m.id);
      assert.ok(ids.includes("alpha-latest"), `got ${ids.join(",")}`);
      assert.ok(ids.includes("beta-latest"), `got ${ids.join(",")}`);
      assert.equal(ids.length, new Set(ids).size, `duplicate rows: ${ids.join(",")}`);
      assert.equal(ids.length, new Set(ids).size, `duplicate rows: ${ids.join(",")}`);
    });
  });

  itIfSqlite("copilot-app registers both routers", async () => {
    await withTempHome("fc-contract-copilot-", async (home) => {
      const dbPath = path.join(home, "data.db");
      await mkdir(path.dirname(dbPath), { recursive: true });
      seedTwoRouterCatalog(home);

      const result = await runFireconnect(
        ["copilot-app", ...API_KEY_ARGS, "--db-path", dbPath, "--force"],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(result.code, 0, result.stderr);
      const out = spawnSync(
        "sqlite3",
        [dbPath, "SELECT model_id FROM provider_models ORDER BY model_id;"],
        { encoding: "utf8" },
      );
      assert.equal(out.status, 0, out.stderr);
      const ids = out.stdout.trim().split("\n");
      assert.ok(ids.includes("alpha-latest"), `got ${ids.join(",")}`);
      assert.ok(ids.includes("beta-latest"), `got ${ids.join(",")}`);
      assert.equal(ids.length, new Set(ids).size, `duplicate rows: ${ids.join(",")}`);
      assert.equal(ids.length, new Set(ids).size, `duplicate rows: ${ids.join(",")}`);
    });
  });

  it("copilot-cli registers both routers and pins the selection", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-contract-copilot-cli-"));
    seedTwoRouterCatalog(home);

    const result = await runFireconnect(["copilot-cli", ...API_KEY_ARGS], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(await readFile(copilotProvidersPath({ home }), "utf8"));
    const ids = config.models
      .filter((model) => model.provider === "fireworks")
      .map((model) => model.id);
    assert.ok(ids.includes("alpha-latest"), `got ${ids.join(",")}`);
    assert.ok(ids.includes("beta-latest"), `got ${ids.join(",")}`);
    assert.equal(ids.length, new Set(ids).size, `duplicate rows: ${ids.join(",")}`);
    let settings = JSON.parse(await readFile(copilotSettingsPath({ home }), "utf8"));
    assert.equal(settings.model, "fireworks/alpha-latest");

    // Switch to the mock gateway's live catalog: selected alpha is absent and
    // newly served standard routers are present. Re-on must retain/register
    // alpha, add the live rows, and remain duplicate-free.
    const reon = await runFireconnect([
      "copilot-cli",
      "on",
      "--api-key",
      "fw_cataloged_v1_adversarial000000",
    ], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(reon.code, 0, reon.stderr);
    settings = JSON.parse(await readFile(copilotSettingsPath({ home }), "utf8"));
    assert.equal(settings.model, "fireworks/alpha-latest");
    const refreshed = JSON.parse(await readFile(copilotProvidersPath({ home }), "utf8"));
    const refreshedIds = refreshed.models
      .filter((model) => model.provider === "fireworks")
      .map((model) => model.id);
    assert.ok(refreshedIds.includes("alpha-latest"), `got ${refreshedIds.join(",")}`);
    assert.ok(refreshedIds.includes("deepseek-v4-flash"), `got ${refreshedIds.join(",")}`);
    assert.equal(
      refreshedIds.length,
      new Set(refreshedIds).size,
      `duplicate rows: ${refreshedIds.join(",")}`,
    );
  });

  itIfSqlite("cursor registers both routers and pins the selection", async () => {
    await withTempHome("fc-contract-cursor-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      seedTwoRouterCatalog(home);
      // Fresh install with no modes to pin: seed a minimal composer mode so
      // the --model selection has somewhere to land (mirrors the baseBlob in
      // cursor-harness.test.mjs).
      const baseBlob = {
        openAIBaseUrl: null,
        useOpenAIKey: false,
        aiSettings: {
          userAddedModels: [],
          modelOverrideEnabled: [],
          modelConfig: {
            composer: {
              modelName: "default",
              maxMode: true,
              selectedModels: [{ modelId: "default", parameters: [] }],
            },
          },
        },
      };
      const init = spawnSync(
        "sqlite3",
        [dbPath, [
          "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
          `INSERT OR REPLACE INTO ItemTable(key,value) VALUES('${CURSOR_APPLICATION_USER_KEY}','${JSON.stringify(baseBlob).replace(/'/g, "''")}');`,
        ].join("\n")],
        { encoding: "utf8" },
      );
      assert.equal(init.status, 0, init.stderr);

      const result = await runCli(
        ["cursor", ...API_KEY_ARGS, "--db-path", dbPath, "--force"],
        {
          home,
          env: { NEXUS_VSCODE_SECRET_PLAINTEXT: "1", FIREWORKS_API_KEY: "" },
        },
      );
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      const out = spawnSync(
        "sqlite3",
        [dbPath, `SELECT value FROM ItemTable WHERE key='${CURSOR_APPLICATION_USER_KEY}';`],
        { encoding: "utf8" },
      );
      assert.equal(out.status, 0, out.stderr);
      const blob = JSON.parse(out.stdout.replace(/\n$/, ""));
      const ids = (blob.aiSettings?.userAddedModels ?? []).map(shortFireworksModelRef);
      assert.ok(ids.includes("alpha-latest"), `got ${ids.join(",")}`);
      assert.ok(ids.includes("beta-latest"), `got ${ids.join(",")}`);
      assert.equal(ids.length, new Set(ids).size, `duplicate rows: ${ids.join(",")}`);
      assert.equal(
        shortFireworksModelRef(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE)),
        "alpha-latest",
      );
    });
  });
});
