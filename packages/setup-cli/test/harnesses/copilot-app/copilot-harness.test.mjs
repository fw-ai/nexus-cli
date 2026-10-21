import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  copilotProviderStatus,
  copilotResolveKey,
  disableCopilotFireworks,
  enableCopilotFireworks,
} from "../../../lib/harnesses/copilot-app/core.mjs";
import { COPILOT_FIREWORKS_BASE_URL } from "../../../lib/harnesses/copilot-app/sqlite.mjs";
import { copilotDataDir } from "../../../lib/harnesses/copilot-app/core.mjs";
import {
  defaultCopilotModelId,
  describeCopilotAppModels,
  resolveCopilotModelId,
} from "../../../lib/harnesses/copilot-shared.mjs";
import { copilotDataDbPath } from "../../../lib/harnesses/copilot-app/sqlite.mjs";
import {
  copilotCliSelectionId,
  deselectCopilotCliModel,
  selectCopilotCliModel,

  copilotProvidersPath,
  disableCopilotCli,
  enableCopilotCli,
} from "../../../lib/harnesses/copilot-cli/config.mjs";
import {
  runCli,
  runCliJson,
  runFireconnect,
  seedKeychainConfig,
  withTempHome,
  FW_OPENCODE_KEY,
} from "../../helpers.mjs";

// The BYOK key rides as an Authorization header on the provider row (see
// sqlite.mjs upsertFireconnectProvider), so this suite needs no OS-keychain
// seam and runs headless as-is.

const HAS_SQLITE = spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0;
const itIfSqlite = HAS_SQLITE ? it : it.skip;

/** Read a single value from a Copilot-shaped DB (first column of first row). */
function readSql(dbPath, sql) {
  const result = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return (result.stdout || "").replace(/\n$/, "");
}

function listProviders(dbPath) {
  return readSql(dbPath, "SELECT id FROM model_providers ORDER BY id;");
}

function providerModels(dbPath, providerId) {
  return readSql(
    dbPath,
    `SELECT model_id FROM provider_models WHERE provider_id = '${providerId}' ORDER BY model_id;`,
  ).split("\n").filter(Boolean);
}

/** Minimal pre-existing Copilot DB: just the built-in github_copilot row. */
async function writeCopilotDb(dbPath) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const sql = [
    "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY);",
    `CREATE TABLE IF NOT EXISTS "model_providers" (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'openai',
      settings_json TEXT NOT NULL DEFAULT '{}',
      account_id TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS "provider_models" (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL REFERENCES "model_providers"(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      wire_model TEXT,
      display_name TEXT NOT NULL,
      max_prompt_tokens INTEGER,
      max_output_tokens INTEGER,
      wire_api_override TEXT,
      supported_reasoning_efforts TEXT,
      UNIQUE (provider_id, model_id)
    );`,
    "INSERT OR IGNORE INTO model_providers (id, name, type, settings_json) VALUES "
      + "('github_copilot:4616bbe8-d81f-4e9a-bda3-97351dd9d564', 'GitHub Copilot', 'github_copilot', "
      + "'{\"authKind\":\"none\",\"baseUrl\":\"\",\"headersJson\":\"{}\",\"wireApi\":\"responses\"}');",
  ].join("\n");
  const result = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function withCopilotDb(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-copilot-"));
  const dbPath = path.join(dir, "data.db");
  await writeCopilotDb(dbPath);
  try {
    await fn(dbPath, dir);
  } finally {
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
}

describe("copilot-app core", () => {
  it("resolves the default db path under ~/.copilot", () => {
    const home = "/tmp/fake-home";
    assert.equal(
      copilotDataDbPath({ home }),
      path.join(home, ".copilot", "data.db"),
    );
    assert.equal(copilotDataDbPath({ home, dbPath: "/custom/db.sqlite" }), "/custom/db.sqlite");
  });

  it("uses ~/.copilot on every platform and honors COPILOT_HOME", () => {
    const home = "/tmp/fake-home";
    // The app keeps its whole tree in ~/.copilot regardless of platform, so
    // there must be no %APPDATA%-style branch to send Windows elsewhere.
    const previousAppData = process.env.APPDATA;
    process.env.APPDATA = "C:\\Users\\x\\AppData\\Roaming";
    try {
      assert.equal(copilotDataDbPath({ home }), path.join(home, ".copilot", "data.db"));
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
    }

    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = "/tmp/relocated-copilot";
    try {
      assert.equal(copilotDataDbPath({ home }), path.join("/tmp/relocated-copilot", "data.db"));
    } finally {
      if (previousHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previousHome;
    }
  });

  it("resolves the data dir under ~/.nexus/copilot-app", () => {
    assert.equal(copilotDataDir("/tmp/h"), path.join("/tmp/h", ".nexus/copilot-app"));
    assert.equal(copilotDataDir("/tmp/h", "/custom/dir"), "/custom/dir");
  });

  it("defaults the model id to the shared Fireworks main model", () => {
    // `auto` has no accounts/fireworks resource path — it passes through bare.
    assert.equal(defaultCopilotModelId("fireworks"), "auto");
    // Explicit ids are normalized to short refs, like other harnesses.
    assert.equal(resolveCopilotModelId("glm-5p2", "fireworks"), "glm-5p2");
    assert.equal(
      resolveCopilotModelId("accounts/fireworks/models/glm-5p2", "fireworks"),
      "glm-5p2",
    );
  });
});

describeIf(HAS_SQLITE, "copilot enable/disable (core)", () => {
  itIfSqlite("on adds an fc- provider with Fireworks settings + models, keeping the built-in row", async () => {
    await withCopilotDb(async (dbPath) => {
      const result = await enableCopilotFireworks({
        dbPath,
        apiKey: FW_OPENCODE_KEY,
        modelId: "accounts/fireworks/models/glm-5p2",
        extraModels: ["accounts/fireworks/models/kimi-k3"],
      });

      assert.match(result.providerId, /^fc-/);
      const settings = JSON.parse(readSql(dbPath, `SELECT settings_json FROM model_providers WHERE id = '${result.providerId}';`));
      assert.equal(settings.baseUrl, COPILOT_FIREWORKS_BASE_URL);
      assert.equal(settings.authKind, "none");
      assert.equal(settings.wireApi, "completions");
      assert.equal(readSql(dbPath, `SELECT name FROM model_providers WHERE id = '${result.providerId}';`), "Fireworks");

      const models = providerModels(dbPath, result.providerId);
      // Fresh installs seed the whole fetched catalog even when --model pins
      // one row (shared fresh-install policy), so both the selected model and
      // the catalog's other entry are registered.
      assert.deepEqual(models, ["glm-5p2", "kimi-k3"]);

      // Context window metadata must be published, or the app reports
      // `hasContextWindowMetadata: false` and hides the readout.
      const limits = readSql(
        dbPath,
        `SELECT max_prompt_tokens || '/' || max_output_tokens FROM provider_models WHERE provider_id = '${result.providerId}' AND model_id = 'glm-5p2';`,
      );
      const [prompt, output] = limits.split("/").map(Number);
      assert.ok(prompt > 0, `expected a context window, got ${limits}`);
      assert.ok(output > 0, `expected an output limit, got ${limits}`);

      // Reasoning efforts must be a JSON array, or the app reports
      // `missing-effort-metadata` and hides the effort control. Same four
      // levels for every model — each verified to return 200 on the gateway.
      for (const modelId of ["glm-5p2", "kimi-k3"]) {
        const efforts = JSON.parse(readSql(
          dbPath,
          `SELECT supported_reasoning_efforts FROM provider_models WHERE provider_id = '${result.providerId}' AND model_id = '${modelId}';`,
        ));
        assert.deepEqual(efforts, ["low", "medium", "high", "max"], modelId);
      }

      // The built-in provider is untouched.
      assert.equal(await copilotProviderStatus(dbPath), "fireworks");
      assert.ok(listProviders(dbPath).includes("github_copilot:4616bbe8-d81f-4e9a-bda3-97351dd9d564"));
    });
  });

  itIfSqlite("off removes only the fc- rows and models", async () => {
    await withCopilotDb(async (dbPath) => {
      const { providerId } = await enableCopilotFireworks({
        dbPath,
        apiKey: FW_OPENCODE_KEY,
        modelId: "glm-5p2",
      });
      const outcome = await disableCopilotFireworks({ dbPath });
      assert.equal(outcome, "restored");
      assert.equal(listProviders(dbPath), "github_copilot:4616bbe8-d81f-4e9a-bda3-97351dd9d564");
      assert.equal(providerModels(dbPath, providerId).length, 0);
      assert.equal(await copilotProviderStatus(dbPath), "none");

      // A second off is a no-op.
      assert.equal(await disableCopilotFireworks({ dbPath }), "none");
    });
  });

  itIfSqlite("explicit model adds without replacing existing models", async () => {
    await withCopilotDb(async (dbPath) => {
      const first = await enableCopilotFireworks({ dbPath, apiKey: FW_OPENCODE_KEY, modelId: "glm-5p2" });
      const second = await enableCopilotFireworks({ dbPath, apiKey: FW_OPENCODE_KEY, modelId: "kimi-k3" });
      assert.equal(second.providerId, first.providerId);
      assert.deepEqual(providerModels(dbPath, first.providerId).sort(), ["glm-5p2", "kimi-k3"]);
    });
  });

  itIfSqlite("single-row upgrade insert is idempotent (INSERT OR IGNORE)", async () => {
    await withCopilotDb(async (dbPath) => {
      const { providerId } = await enableCopilotFireworks({ dbPath, apiKey: FW_OPENCODE_KEY, modelId: "glm-5p2" });
      const { insertCopilotProviderModel } = await import("../../../lib/harnesses/copilot-app/sqlite.mjs");
      const [autoRow] = describeCopilotAppModels(["auto"]);
      await insertCopilotProviderModel(dbPath, { providerId, model: autoRow });
      // A repeated upgrade must not trip UNIQUE(provider_id, model_id).
      await insertCopilotProviderModel(dbPath, { providerId, model: autoRow });
      assert.deepEqual(
        providerModels(dbPath, providerId).filter((id) => id === "auto"),
        ["auto"],
      );
    });
  });

  itIfSqlite("enable works on a fresh DB with no tables (never-launched app)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-copilot-fresh-"));
    const dbPath = path.join(dir, "data.db");
    try {
      const { providerId } = await enableCopilotFireworks({ dbPath, apiKey: FW_OPENCODE_KEY, modelId: "glm-5p2" });
      assert.match(providerId, /^fc-/);
      assert.equal(await copilotProviderStatus(dbPath), "fireworks");

      // The row holds the API key in a header, so a DB we created ourselves
      // must not be left world-readable by the process umask.
      const { statSync } = await import("node:fs");
      assert.equal(statSync(dbPath).mode & 0o077, 0, "data.db must be owner-only");
    } finally {
      await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
    }
  });

  itIfSqlite("keeps previously registered models when the catalog is unavailable", async () => {
    await withCopilotDb(async (dbPath) => {
      await enableCopilotFireworks({
        dbPath,
        apiKey: FW_OPENCODE_KEY,
        extraModels: ["glm-5p2", "kimi-k3", "minimax-m3"],
      });
      const { providerId } = await enableCopilotFireworks({
        dbPath,
        apiKey: FW_OPENCODE_KEY,
        extraModels: [],
        catalogUnavailable: true,
      });
      assert.deepEqual(
        providerModels(dbPath, providerId).sort(),
        ["auto", "glm-5p2", "kimi-k3", "minimax-m3"],
      );
    });
  });

  itIfSqlite("plain re-on prunes delisted rows and adds newly served ones", async () => {
    await withCopilotDb(async (dbPath) => {
      await enableCopilotFireworks({
        dbPath, apiKey: FW_OPENCODE_KEY, extraModels: ["glm-5p2", "kimi-k3"],
      });
      const { providerId } = await enableCopilotFireworks({
        dbPath, apiKey: FW_OPENCODE_KEY, extraModels: ["kimi-k3", "deepseek-v4-pro"],
      });
      assert.deepEqual(providerModels(dbPath, providerId), ["auto", "deepseek-v4-pro", "kimi-k3"]);
    });
  });

  itIfSqlite("stores the key as an Authorization header and reads it back", async () => {
    await withCopilotDb(async (dbPath) => {
      const { providerId } = await enableCopilotFireworks({
        dbPath, apiKey: FW_OPENCODE_KEY, modelId: "glm-5p2",
      });
      const settings = JSON.parse(readSql(dbPath, `SELECT settings_json FROM model_providers WHERE id = '${providerId}';`));
      // authKind "none" keeps the app out of the OS keychain; the header
      // authenticates every session the app spawns.
      assert.equal(settings.authKind, "none");
      assert.deepEqual(JSON.parse(settings.headersJson), {
        Authorization: `Bearer ${FW_OPENCODE_KEY}`,
      });
      assert.equal(await copilotResolveKey(dbPath), FW_OPENCODE_KEY);
      assert.equal(await copilotProviderStatus(dbPath), "fireworks");
    });
  });

  itIfSqlite("resolves no key when the row carries no usable header", async () => {
    await withCopilotDb(async (dbPath) => {
      const { providerId } = await enableCopilotFireworks({
        dbPath, apiKey: FW_OPENCODE_KEY, modelId: "glm-5p2",
      });
      const stripped = JSON.stringify({
        authKind: "none", baseUrl: COPILOT_FIREWORKS_BASE_URL, headersJson: "{}", wireApi: "completions",
      });
      spawnSync("sqlite3", [dbPath, `UPDATE model_providers SET settings_json = '${stripped}' WHERE id = '${providerId}';`]);
      assert.equal(await copilotResolveKey(dbPath), "");
      // The row is still ours, so `off` can still clean it up.
      assert.equal(await copilotProviderStatus(dbPath), "fireworks");
    });
  });
});

describe("copilot-app CLI config (providers.json)", () => {
  it("declares vision from the catalog's per-model flag", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-copilot-vision-"));
    const providersPath = path.join(dir, "providers.json");
    const { readFile, rm } = await import("node:fs/promises");
    await enableCopilotCli({
      providersPath,
      dataDir: path.join(dir, "data"),
      apiKey: FW_OPENCODE_KEY,
      models: [
        { id: "kimi-latest", displayName: "Kimi Latest", vision: true },
        { id: "glm-latest", displayName: "GLM Latest", vision: false },
      ],
    });
    const cfg = JSON.parse(await readFile(providersPath, "utf8"));
    const kimi = cfg.models.find((m) => m.id === "kimi-latest");
    const glm = cfg.models.find((m) => m.id === "glm-latest");
    assert.equal(kimi.capabilities.supports.vision, true);
    assert.ok(kimi.capabilities.limits.vision.max_prompt_images > 0);
    // A model that 400s on image input must not advertise one.
    assert.equal(glm.capabilities.supports.vision, undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("selects a model in settings.json, preserving other settings", async () => {
    // Registering models is not enough — a BYOK provider has no default, so
    // without a selection `copilot -p ...` fails with "No supported model
    // available" ("Custom provider requires an explicit model" in its log).
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-copilot-sel-"));
    const settingsPath = path.join(dir, "settings.json");
    const dataDir = path.join(dir, "data");
    const { writeFile, readFile, rm } = await import("node:fs/promises");
    await writeFile(settingsPath, JSON.stringify({ theme: "dark", effortLevel: "high" }, null, 2));

    await selectCopilotCliModel({ settingsPath, dataDir, selectionId: "fireworks/glm-latest" });
    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(after.model, "fireworks/glm-latest");
    assert.equal(after.theme, "dark", "unrelated settings must survive");
    assert.equal(after.effortLevel, "high");

    assert.equal(await deselectCopilotCliModel({ settingsPath, dataDir }), "restored");
    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.model, undefined);
    assert.equal(restored.theme, "dark");
    await rm(dir, { recursive: true, force: true });
  });


  it("qualifies selection ids with the provider name", () => {
    // A bare id is rejected by the CLI ("Model … is not available") and falls
    // back to another model, so the prefix is not cosmetic.
    assert.equal(copilotCliSelectionId("glm-latest"), "fireworks/glm-latest");
  });

  it("resolves providers.json under the config dir, honoring COPILOT_HOME", () => {
    const home = "/tmp/fake-home";
    assert.equal(
      copilotProvidersPath({ home }),
      path.join(home, ".copilot", "providers.json"),
    );
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = "/tmp/relocated";
    try {
      assert.equal(copilotProvidersPath({ home }), path.join("/tmp/relocated", "providers.json"));
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
    }
  });

  it("preserves the user's own providers and models, and restores them on off", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-copilot-cli-"));
    const providersPath = path.join(dir, "providers.json");
    const dataDir = path.join(dir, "data");
    const { writeFile, readFile, rm } = await import("node:fs/promises");
    // A hand-written config, with deliberately unusual formatting so the
    // byte-for-byte restore is meaningful.
    const original = '{\n  "providers": [ { "name": "mine", "baseUrl": "https://example.test" } ],\n  "models": [ { "id": "m1", "provider": "mine" } ]\n}\n';
    await writeFile(providersPath, original);

    await enableCopilotCli({
      providersPath,
      dataDir,
      apiKey: FW_OPENCODE_KEY,
      models: [{ id: "glm-5p2", displayName: "GLM 5.2", maxPromptTokens: 1000, maxOutputTokens: 100 }],
    });

    const written = JSON.parse(await readFile(providersPath, "utf8"));
    assert.deepEqual(written.providers.map((p) => p.name).sort(), ["fireworks", "mine"]);
    assert.deepEqual(written.models.map((m) => m.id).sort(), ["glm-5p2", "m1"]);
    const ours = written.models.find((m) => m.id === "glm-5p2");
    assert.equal(ours.provider, "fireworks");
    assert.equal(ours.capabilities.supports.reasoningEffort, true);
    // glm-5p2 is not in the verified-vision set, so no vision is claimed.
    assert.equal(ours.capabilities.supports.vision, undefined);
    assert.equal(ours.capabilities.limits, undefined);

    assert.equal(await disableCopilotCli({ providersPath, dataDir }), "restored");
    assert.equal(await readFile(providersPath, "utf8"), original, "must restore byte-for-byte");
    await rm(dir, { recursive: true, force: true });
  });

  it("removes a providers.json it created rather than leaving an empty shell", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-copilot-cli-new-"));
    const providersPath = path.join(dir, "providers.json");
    const dataDir = path.join(dir, "data");
    const { rm } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");

    await enableCopilotCli({
      providersPath, dataDir, apiKey: FW_OPENCODE_KEY,
      models: [{ id: "glm-5p2", displayName: "GLM 5.2" }],
    });
    assert.equal(existsSync(providersPath), true);
    assert.equal(await disableCopilotCli({ providersPath, dataDir }), "restored");
    assert.equal(existsSync(providersPath), false);
    await rm(dir, { recursive: true, force: true });
  });

  it("strips only its own entries when the backup is gone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-copilot-cli-strip-"));
    const providersPath = path.join(dir, "providers.json");
    const dataDir = path.join(dir, "data");
    const { writeFile, readFile, rm } = await import("node:fs/promises");

    await writeFile(providersPath, JSON.stringify({
      providers: [{ name: "mine", baseUrl: "https://example.test" }, { name: "fireworks", baseUrl: "x" }],
      models: [{ id: "m1", provider: "mine" }, { id: "glm-5p2", provider: "fireworks" }],
    }, null, 2));

    // No backup written — the legacy/no-snapshot path.
    assert.equal(await disableCopilotCli({ providersPath, dataDir }), "stripped");
    const after = JSON.parse(await readFile(providersPath, "utf8"));
    assert.deepEqual(after.providers.map((p) => p.name), ["mine"]);
    assert.deepEqual(after.models.map((m) => m.id), ["m1"]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("copilot-app CLI", () => {
  it("help mentions the harness", async () => {
    const { stdout } = await runCli(["copilot-app", "help"]);
    assert.match(stdout, /Copilot app through Fireworks/);
    assert.match(stdout, /--db-path/);
  });

  it("main help lists copilot", async () => {
    const { stdout, code } = await runCli(["help"]);
    assert.equal(code, 0);
    assert.match(stdout, /copilot-app\s+GitHub Copilot desktop app/);
  });

  it("status --json reports off state on a bare home", async () => {
    await withTempHome("copilot-status-", async (home) => {
      const { json } = await runCliJson(["copilot-app", "status", "--json"], { home });
      assert.equal(json.harness, "copilot-app");
      assert.equal(json.provider, "none");
      assert.equal(json.enabled, false);
    });
  });

  itIfSqlite("on then off round-trips the provider rows", async () => {
    await withTempHome("copilot-cli-", async (home) => {
      const dbPath = copilotDataDbPath({ home });
      await writeCopilotDb(dbPath);
      // --force: the dev machine may have the real Copilot app open (the
      // quit-guard fires on the live process). Writes target a temp DB, so
      // forcing is safe here. Mirrors codexOnOffArgs.
      const on = await runFireconnect(["copilot-app", "on", "--db-path", dbPath, "--force"], {
        HOME: home,
        FIREWORKS_API_KEY: FW_OPENCODE_KEY,
      });
      assert.equal(on.code, 0, on.stderr);
      assert.match(on.stdout, /Copilot app → Fireworks/);
      assert.equal(await copilotProviderStatus(dbPath), "fireworks");
      assert.ok(listProviders(dbPath).split("\n").some((id) => id.startsWith("fc-")));

      const { json: payload } = await runCliJson(["copilot-app", "status", "--json", "--db-path", dbPath], { home });
      assert.equal(payload.provider, "fireworks");
      assert.ok(payload.hasKey !== undefined);

      const off = await runFireconnect(["copilot-app", "off", "--db-path", dbPath, "--force"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);
      assert.equal(await copilotProviderStatus(dbPath), "none");
      assert.equal(listProviders(dbPath), "github_copilot:4616bbe8-d81f-4e9a-bda3-97351dd9d564");
    });
  });

  it("rejects --force-adjacent flags for other harnesses consistently", async () => {
    // --db-path was cursor-only before; copilot now accepts it, claude must not.
    await withTempHome("copilot-flags-", async (home) => {
      const { code, stderr } = await runCli(["claude", "status", "--db-path", "/tmp/x.db"], { home });
      assert.equal(code, 1);
      assert.match(stderr, /--db-path is supported only by Cursor and the Copilot app/);
    });
  });
});

function describeIf(condition, name, fn) {
  if (condition) {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

describe("migrateCopilotAppFirerouterOnUpgrade", () => {
  itIfSqlite("deletes FireRouter rows from the Nexus provider, then no-ops", async () => {
    await withTempHome("copilot-app-firerouter-upgrade-", async (home) => {
      const { copilotAppPathsFor } = await import("../../../lib/harness/context.mjs");
      const { writeGlobalConfig } = await import("../../../lib/config/global-config.mjs");
      const { insertCopilotProviderModel } = await import("../../../lib/harnesses/copilot-app/sqlite.mjs");
      const { migrateCopilotAppFirerouterOnUpgrade } = await import("../../../lib/harnesses/copilot-app/upgrade-migrations.mjs");
      const dbPath = copilotAppPathsFor({ home }).dbPath;
      const { providerId } = await enableCopilotFireworks({ dbPath, apiKey: FW_OPENCODE_KEY, modelId: "glm-5p2" });
      await insertCopilotProviderModel(dbPath, {
        providerId,
        model: { id: "firerouter/opus", displayName: "FireRouter · Opus", wireModel: "firerouter/opus" },
      });
      await writeGlobalConfig(home, { harnesses: { "copilot-app": { enabled: true, provider: "fireworks" } } });

      assert.equal(await migrateCopilotAppFirerouterOnUpgrade(home, { isRunning: () => false }), true);
      const remaining = providerModels(dbPath, providerId);
      assert.ok(remaining.includes("glm-5p2"), remaining.join(","));
      assert.ok(!remaining.some((id) => id.startsWith("firerouter")), remaining.join(","));
      assert.equal(await migrateCopilotAppFirerouterOnUpgrade(home, { isRunning: () => false }), false);
      assert.equal(await migrateCopilotAppFirerouterOnUpgrade(home, { isRunning: () => true }), false);
    });
  });
});
