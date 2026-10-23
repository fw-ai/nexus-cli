import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { FIREROUTER_ROUTER_ID } from "../../../lib/fireworks/model-id.mjs";
import {
  CURSOR_FIREWORKS_BASE_URL,
  CURSOR_DEFAULT_MODE,
  addUserModel,
  cursorCurrentModelId,
  cursorProviderStatus,
  dropCursorFirerouterSelection,
  disableUnservableModels,
  existingModes,
  prettyModelName,
  pruneUnservableAddedModels,
  reenableFireconnectDisabledModels,
  removeFireconnectModels,
  resetFireconnectModelConfig,
  setAllExistingModes,
  setModeModel,
  setOpenAiBaseUrl,
  setUseOpenAiKey,
} from "../../../lib/harnesses/cursor/core.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { isCachedServerlessModelRef, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  mockServerlessModel,
  runCli,
  runCliJson,
  runFireconnect,
  seedKeychainConfig,
  withTempHome,
} from "../../helpers.mjs";
import { decryptSecret } from "../../../lib/harnesses/vscode/safestorage.mjs";
import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { cursorPathsFor } from "../../../lib/harness/context.mjs";
import { migrateCursorFirerouterOnUpgrade } from "../../../lib/harnesses/cursor/upgrade-migrations.mjs";

// Cursor's key cell is an Electron safeStorage-encrypted `secret://` row. Set
// the plaintext seam process-wide so `encryptSecret`/`decryptSecret` are the
// identity in every spawned CLI (which inherit this env), letting the suite
// run headless / on CI with no OS keychain prompt. Mirrors the vscode harness
// suite's use of the same seam.
process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = "1";

const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

/** Minimal Cursor-shaped blob for tests. */
function baseBlob(overrides = {}) {
  return {
    openAIBaseUrl: null,
    useOpenAIKey: false,
    aiSettings: {
      userAddedModels: [],
      modelOverrideEnabled: [],
      modelConfig: {
        composer: { modelName: "default", maxMode: true, selectedModels: [{ modelId: "default", parameters: [] }] },
      },
    },
    ...overrides,
  };
}

/**
 * Build a temp state.vscdb with the applicationUser row (and optional key).
 * @param {string} dbPath
 * @param {object} blob
 * @param {{ openAIKey?: string }} [opts]
 */
function writeCursorDb(dbPath, blob, opts = {}) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT OR REPLACE INTO ItemTable(key,value) VALUES('${APPLICATION_USER_KEY}','${jsonLit(blob)}');`,
  ];
  if (opts.openAIKey != null) {
    // Modern Cursor reads the encrypted `secret://cursorAuth/openAIKey` cell.
    // Under the plaintext seam `encryptSecret` is the identity, so the raw key
    // lands in the cell verbatim. An empty string is the IDE-cleared state:
    // Cursor writes an empty safeStorage ciphertext (`{"type":"Buffer","data":[]}`),
    // not a literal "" — reproduce that shape so the regression test mirrors
    // real on-disk state.
    const cell = opts.openAIKey === ""
      ? '{"type":"Buffer","data":[]}'
      : String(opts.openAIKey).replace(/'/g, "''");
    sql.push(`INSERT OR REPLACE INTO ItemTable(key,value) VALUES('secret://cursorAuth/openAIKey','${cell}');`);
  }
  const r = spawnSync("sqlite3", [dbPath, sql.join("\n")], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(`sqlite3 init failed: ${r.stderr || r.error?.message}`);
  }
}

/** Escape a JS value into a SQL string-literal body for JSON text. */
function jsonLit(v) {
  return JSON.stringify(v).replace(/'/g, "''");
}

/** Read the applicationUser blob back from a temp DB. */
function readBlob(dbPath) {
  const r = spawnSync("sqlite3", [dbPath, `SELECT value FROM ItemTable WHERE key='${APPLICATION_USER_KEY}';`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`sqlite3 read failed: ${r.stderr || r.error?.message}`);
  }
  const raw = r.stdout.replace(/\n$/, "");
  return raw ? JSON.parse(raw) : null;
}

function readKey(dbPath) {
  const r = spawnSync("sqlite3", [dbPath, "SELECT value FROM ItemTable WHERE key='secret://cursorAuth/openAIKey';"], {
    encoding: "utf8",
  });
  return (r.stdout ?? "").replace(/\n$/, "");
}

/**
 * Read the secret key cell and decrypt it, the way Cursor/fireconnect do.
 * Under the plaintext seam this is the identity over the raw cell value; for the
 * empty-ciphertext Cursor writes when clearing the key it returns "".
 */
function decryptSecretCell(dbPath) {
  return decryptSecret(readKey(dbPath), { variant: "cursor" });
}

/** Resolve the sqlite3 CLI binary (honour PATH; conda's sqlite3 is fine). */
function sqliteAvailable() {
  const r = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
  return r.status === 0;
}

const HAS_SQLITE = sqliteAvailable();
const itIfSqlite = HAS_SQLITE ? it : it.skip;

/* -------------------------------------------------------------------------- */
/* Unit tests — pure blob transforms (no I/O)                                  */
/* -------------------------------------------------------------------------- */

const SERVABLE_CATALOG_ROWS = [
  mockServerlessModel({
    name: "accounts/fireworks/models/glm-5p2",
    context_length: 1_048_576,
    aliases: ["accounts/fireworks/routers/glm-latest"],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/kimi-k3",
    context_length: 1_048_576,
    aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
  }),
];

describe("cursor-core pure transforms", () => {
  before(() => {
    setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(SERVABLE_CATALOG_ROWS));
  });

  after(() => {
    setServerlessCatalogSnapshot(null);
  });
  it("addUserModel dedupes, enables, and tracks ownership", () => {
    let b = baseBlob({ aiSettings: { userAddedModels: ["mine"], modelConfig: {} } });
    b = addUserModel(b, "accounts/fireworks/routers/glm-5p2");
    b = addUserModel(b, "accounts/fireworks/routers/glm-5p2"); // dedupe
    assert.deepEqual(b.aiSettings.userAddedModels, ["mine", "glm-5p2"]);
    assert.deepEqual(b.aiSettings.modelOverrideEnabled, ["glm-5p2"]);
    assert.deepEqual(b.aiSettings.fireconnectAddedModels, ["glm-5p2"]);
  });

  it("removeFireconnectModels only removes fireconnect-registered models", () => {
    let b = baseBlob();
    b = addUserModel(b, "accounts/fireworks/routers/glm-5p2");
    b.aiSettings.userAddedModels.push("user-own-model");
    b.aiSettings.modelOverrideEnabled.push("user-own-model");
    b = removeFireconnectModels(b);
    assert.deepEqual(b.aiSettings.userAddedModels, ["user-own-model"]);
    assert.deepEqual(b.aiSettings.modelOverrideEnabled, ["user-own-model"]);
    assert.deepEqual(b.aiSettings.fireconnectAddedModels, []);
  });

  it("setModeModel writes modelName + selectedModels and preserves maxMode", () => {
    let b = baseBlob();
    b = setModeModel(b, "composer", "accounts/fireworks/routers/glm-latest");
    assert.equal(b.aiSettings.modelConfig.composer.modelName, "glm-latest");
    assert.equal(b.aiSettings.modelConfig.composer.maxMode, true); // preserved
    assert.deepEqual(b.aiSettings.modelConfig.composer.selectedModels, [
      { modelId: "glm-latest", parameters: [] },
    ]);
    assert.deepEqual(b.aiSettings.fireconnectTouchedModes, ["composer"]);
  });

  it("resetFireconnectModelConfig resets only touched modes", () => {
    let b = baseBlob();
    b = setModeModel(b, "composer", "glm-5p2");
    b.aiSettings.modelConfig["cmd-k"] = { modelName: "user-chosen", selectedModels: [] }; // user's own
    // Default target: Cursor's literal "default" (used by the `off` strip fallback).
    b = resetFireconnectModelConfig(b);
    assert.equal(b.aiSettings.modelConfig.composer.modelName, "default");
    assert.equal(b.aiSettings.modelConfig["cmd-k"].modelName, "user-chosen"); // untouched
    assert.deepEqual(b.aiSettings.fireconnectTouchedModes, []);
  });

  it("resetFireconnectModelConfig resets touched modes to a Fireworks model when given", () => {
    let b = baseBlob();
    b = setModeModel(b, "composer", "glm-5p2");
    b = resetFireconnectModelConfig(b, "accounts/fireworks/routers/glm-latest");
    assert.equal(b.aiSettings.modelConfig.composer.modelName, "glm-latest");
    assert.deepEqual(
      b.aiSettings.modelConfig.composer.selectedModels,
      [{ modelId: "glm-latest", parameters: [] }],
    );
    assert.deepEqual(b.aiSettings.fireconnectTouchedModes, []);
  });

  it("setOpenAiBaseUrl / setUseOpenAiKey set fields", () => {
    let b = baseBlob();
    b = setOpenAiBaseUrl(b, CURSOR_FIREWORKS_BASE_URL);
    b = setUseOpenAiKey(b, true);
    assert.equal(b.openAIBaseUrl, CURSOR_FIREWORKS_BASE_URL);
    assert.equal(b.useOpenAIKey, true);
  });

  it("cursorProviderStatus reflects key type + useOpenAIKey", () => {
    const fw = baseBlob({ useOpenAIKey: true });
    assert.equal(cursorProviderStatus(fw, "fw_abc"), "fireworks");
    assert.equal(cursorProviderStatus(fw, "fpk_abc"), "none");
    assert.equal(cursorProviderStatus(baseBlob({ useOpenAIKey: false }), "fw_abc"), "none");
    assert.equal(cursorProviderStatus(fw, "sk-ant-abc"), "none");
  });

  // Regression: a teardown that cleared the key cell without finishing the blob
  // strip leaves Cursor routed with its built-ins hidden and no readable key.
  // Reporting "none" for that made `off` a permanent no-op and hid the harness
  // from `uninstall`, so the built-ins could never be restored. Seen in the
  // wild: 9 models registered, 18 built-ins hidden, key cell empty.
  it("cursorProviderStatus still reports managed when the key is gone", () => {
    const stranded = baseBlob({
      useOpenAIKey: true,
      openAIBaseUrl: CURSOR_FIREWORKS_BASE_URL,
      aiSettings: {
        userAddedModels: ["kimi-fast-latest"],
        modelOverrideEnabled: [],
        modelOverrideDisabled: ["auto-smart"],
        modelConfig: {},
        fireconnectAddedModels: ["kimi-fast-latest"],
        fireconnectDisabledModels: ["auto-smart"],
      },
    });
    assert.equal(cursorProviderStatus(stranded, ""), "fireworks");
    // Azure is distinguished by the base URL we pointed Cursor at.
    assert.equal(
      cursorProviderStatus({ ...stranded, openAIBaseUrl: "https://x.services.ai.azure.com" }, ""),
      "azure",
    );
  });

  it("cursorProviderStatus does not claim a keyless Cursor we never touched", () => {
    // Same missing key, but no markers: this is the user's own config, so it
    // must stay "none" or `off` would strip a setup Nexus did not create.
    const untouched = baseBlob({
      useOpenAIKey: true,
      openAIBaseUrl: "https://api.openai.com/v1",
      aiSettings: { userAddedModels: ["gpt-4o"], modelOverrideEnabled: [], modelConfig: {} },
    });
    assert.equal(cursorProviderStatus(untouched, ""), "none");
  });

  it("cursorFireworksModelRef aliases auto to nexus/auto and shortens Fireworks paths", () => {
    assert.equal(addUserModel(baseBlob(), "auto").aiSettings.userAddedModels[0], "nexus/auto");
    assert.equal(addUserModel(baseBlob(), "nexus/auto").aiSettings.userAddedModels[0], "nexus/auto");
    assert.equal(addUserModel(baseBlob(), "auto-instant").aiSettings.userAddedModels[0], "auto-instant");
    assert.equal(setModeModel(baseBlob(), "composer", "auto").aiSettings.modelConfig.composer.modelName, "nexus/auto");
  });

  it("cursorCurrentModelId reads the active model for a mode", () => {
    let b = baseBlob();
    b = setModeModel(b, "composer", "glm-5p2");
    assert.equal(cursorCurrentModelId(b, "composer"), "glm-5p2");
    assert.equal(cursorCurrentModelId(b, "cmd-k"), "");
  });

  it("prettyModelName renders human-readable names", () => {
    assert.equal(prettyModelName("accounts/fireworks/models/glm-5p2"), "GLM 5.2");
    assert.equal(prettyModelName("accounts/fireworks/routers/glm-latest"), "GLM Latest");
    assert.equal(prettyModelName("accounts/fireworks/routers/kimi-k3-fast"), "Kimi K3 Fast");
    assert.equal(prettyModelName("accounts/fireworks/models/deepseek-v4-flash"), "Deepseek V4 Flash");
    assert.equal(prettyModelName("composer-2.5"), "Composer 2.5");
    assert.equal(prettyModelName("default"), "default");
    assert.equal(prettyModelName(""), "(unset)");
  });

  it("setAllExistingModes sets every existing mode and creates no new ones", () => {
    const b = baseBlob({
      aiSettings: {
        userAddedModels: [],
        modelOverrideEnabled: [],
        modelConfig: {
          composer: { modelName: "default", maxMode: true },
          "cmd-k": { modelName: "default" },
        },
      },
    });
    assert.deepEqual(existingModes(b), ["composer", "cmd-k"]);
    const next = setAllExistingModes(b, "accounts/fireworks/routers/glm-latest");
    assert.equal(cursorCurrentModelId(next, "composer"), "glm-latest");
    assert.equal(cursorCurrentModelId(next, "cmd-k"), "glm-latest");
    // no new modes created
    assert.deepEqual(existingModes(next), ["composer", "cmd-k"]);
    assert.deepEqual(next.aiSettings.fireconnectTouchedModes, ["composer", "cmd-k"]);
  });

  const servableOnly = (...ids) => {
    const set = new Set(ids);
    return (id) => set.has(id) || isCachedServerlessModelRef(id);
  };

  it("pruneUnservableAddedModels drops only unservable fireconnect-tracked ids", () => {
    let b = baseBlob();
    b.aiSettings.userAddedModels = ["auto-smart", "kimi-fast-latest", "user-own-model"];
    b.aiSettings.modelOverrideEnabled = ["auto-smart", "kimi-fast-latest", "user-own-model"];
    b.aiSettings.fireconnectAddedModels = ["auto-smart", "kimi-fast-latest"];
    const next = pruneUnservableAddedModels(b, { servable: servableOnly() });
    assert.deepEqual(next.aiSettings.userAddedModels, ["kimi-fast-latest", "user-own-model"]);
    assert.deepEqual(next.aiSettings.modelOverrideEnabled, ["kimi-fast-latest", "user-own-model"]);
    assert.deepEqual(next.aiSettings.fireconnectAddedModels, ["kimi-fast-latest"]);
  });

  it("disableUnservableModels hides built-ins but keeps servable and user-owned models", () => {
    const b = baseBlob({
      availableDefaultModels2: [
        { name: "auto-smart" },
        { name: "claude-sonnet-4-6" },
        { name: "kimi-k3" }, // also a Fireworks model — stays
      ],
    });
    b.aiSettings.modelOverrideEnabled = ["gpt-5.5", "glm-5p2"];
    b.aiSettings.userAddedModels = ["user-own-model"];
    b.aiSettings.modelOverrideDisabled = [];
    const next = disableUnservableModels(b, { servable: servableOnly() });
    assert.deepEqual(next.aiSettings.modelOverrideDisabled, ["auto-smart", "claude-sonnet-4-6", "gpt-5.5"]);
    assert.deepEqual(next.aiSettings.fireconnectDisabledModels, ["auto-smart", "claude-sonnet-4-6", "gpt-5.5"]);
    // enabled overrides disabled in Cursor's picker — hidden models must leave
    // the enabled list too (tracked for restore); servable ones stay
    assert.deepEqual(next.aiSettings.modelOverrideEnabled, ["glm-5p2"]);
    assert.deepEqual(next.aiSettings.fireconnectToggledOffModels, ["gpt-5.5"]);
  });

  it("disableUnservableModels strips already-disabled ids from the enabled list", () => {
    const b = baseBlob();
    b.aiSettings.modelOverrideEnabled = ["gpt-5.5"];
    b.aiSettings.modelOverrideDisabled = ["gpt-5.5"]; // hidden by an earlier run
    b.aiSettings.fireconnectDisabledModels = ["gpt-5.5"];
    const next = disableUnservableModels(b, { servable: servableOnly() });
    assert.deepEqual(next.aiSettings.modelOverrideEnabled, []);
    assert.deepEqual(next.aiSettings.fireconnectToggledOffModels, ["gpt-5.5"]);
    assert.deepEqual(next.aiSettings.modelOverrideDisabled, ["gpt-5.5"]);
  });

  it("disableUnservableModels re-enables tracked ids that became servable", () => {
    const b = baseBlob();
    b.aiSettings.modelOverrideDisabled = ["kimi-fast-latest", "auto-smart"];
    b.aiSettings.fireconnectDisabledModels = ["kimi-fast-latest", "auto-smart"];
    const next = disableUnservableModels(b, { servable: servableOnly() });
    assert.deepEqual(next.aiSettings.modelOverrideDisabled, ["auto-smart"]);
    assert.deepEqual(next.aiSettings.fireconnectDisabledModels, ["auto-smart"]);
  });

  it("reenableFireconnectDisabledModels un-hides only fireconnect-tracked ids and restores toggles", () => {
    const b = baseBlob();
    b.aiSettings.modelOverrideDisabled = ["auto-smart", "user-hid-this"];
    b.aiSettings.fireconnectDisabledModels = ["auto-smart"];
    b.aiSettings.modelOverrideEnabled = ["kimi-fast-latest"];
    b.aiSettings.fireconnectToggledOffModels = ["gpt-5.5"];
    const next = reenableFireconnectDisabledModels(b);
    assert.deepEqual(next.aiSettings.modelOverrideDisabled, ["user-hid-this"]);
    assert.deepEqual(next.aiSettings.fireconnectDisabledModels, []);
    // enabled entries we stripped come back; the user's own are untouched
    assert.deepEqual(next.aiSettings.modelOverrideEnabled, ["kimi-fast-latest", "gpt-5.5"]);
    assert.deepEqual(next.aiSettings.fireconnectToggledOffModels, []);
  });
});

/* -------------------------------------------------------------------------- */
/* Integration tests — CLI against a real temp state.vscdb                     */
/* -------------------------------------------------------------------------- */

describe("cursor harness integration", () => {
  itIfSqlite("on persists --api-key flag to keychain", async () => {
    await withTempHome("cursor-keychain-flag-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const apiKey = "fw_cursor_on_flag_key_123456";

      const r = await runCli(
        ["cursor", "on", "--api-key", apiKey, "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const exportR = await runFireconnect(["key", "export"], {
        HOME: home,
        FIREWORKS_API_KEY: "",
      });
      assert.equal(exportR.code, 0, exportR.stderr);
      assert.equal(exportR.stdout.trim(), apiKey);
    });
  });

  itIfSqlite("on persists harness-local Fireworks key to keychain", async () => {
    await withTempHome("cursor-keychain-local-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const harnessKey = "fw_cursor_harness_local_key12";
      const blob = baseBlob();
      blob.useOpenAIKey = true;
      blob.openAIBaseUrl = CURSOR_FIREWORKS_BASE_URL;
      writeCursorDb(dbPath, blob, { openAIKey: harnessKey });

      const r = await runCli(
        ["cursor", "on", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const exportR = await runFireconnect(["key", "export"], {
        HOME: home,
        FIREWORKS_API_KEY: "",
      });
      assert.equal(exportR.code, 0, exportR.stderr);
      assert.equal(exportR.stdout.trim(), harnessKey);
    });
  });

  itIfSqlite("on writes base url, key, registers default model, sets composer", async () => {
    await withTempHome("cursor-on-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const r = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const blob = readBlob(dbPath);
      assert.equal(blob.openAIBaseUrl, CURSOR_FIREWORKS_BASE_URL);
      assert.equal(blob.useOpenAIKey, true);
      assert.ok(blob.aiSettings.userAddedModels.includes("nexus/auto"));
      assert.ok(blob.aiSettings.fireconnectAddedModels.includes("nexus/auto"));
      assert.equal(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE), "nexus/auto");
      assert.equal(readKey(dbPath), "fw_test_key_12345");
    });
  });

  itIfSqlite("plain re-on backfills a missing `nexus/auto` row and migrates bare `auto` on an existing install", async () => {
    // Regression: an install routed before `nexus/auto` became Cursor's auto
    // id has either no auto row or bare `auto` (which collides with Cursor's
    // own Auto router). A re-`on` must migrate bare `auto` to `nexus/auto`
    // and backfill `nexus/auto` when missing.
    await withTempHome("cursor-auto-backfill-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const first = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(first.code, 0, `stderr: ${first.stderr}`);

      // Simulate an older install that registered and selected bare `auto`.
      const legacyAuto = readBlob(dbPath);
      legacyAuto.aiSettings.userAddedModels = legacyAuto.aiSettings.userAddedModels.map((id) => (id === "nexus/auto" ? "auto" : id));
      legacyAuto.aiSettings.modelOverrideEnabled = legacyAuto.aiSettings.modelOverrideEnabled.map((id) => (id === "nexus/auto" ? "auto" : id));
      legacyAuto.aiSettings.fireconnectAddedModels = (legacyAuto.aiSettings.fireconnectAddedModels ?? [])
        .map((id) => (id === "nexus/auto" ? "auto" : id));
      legacyAuto.aiSettings.modelConfig.composer.modelName = "auto";
      legacyAuto.aiSettings.modelConfig.composer.selectedModels = [{ modelId: "auto", parameters: [] }];
      writeCursorDb(dbPath, legacyAuto);

      const migrated = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(migrated.code, 0, `stderr: ${migrated.stderr}`);
      const migratedBlob = readBlob(dbPath);
      assert.equal(cursorCurrentModelId(migratedBlob, CURSOR_DEFAULT_MODE), "nexus/auto");
      assert.ok(migratedBlob.aiSettings.userAddedModels.includes("nexus/auto"));
      assert.ok(!migratedBlob.aiSettings.userAddedModels.includes("auto"));
      assert.ok((migratedBlob.aiSettings.fireconnectAddedModels ?? []).includes("nexus/auto"));
      assert.ok(!(migratedBlob.aiSettings.fireconnectAddedModels ?? []).includes("auto"));

      // Simulate the pre-auto install: routed, catalog registered, no auto row.
      const stale = readBlob(dbPath);
      stale.aiSettings.userAddedModels = stale.aiSettings.userAddedModels.filter((id) => id !== "nexus/auto");
      stale.aiSettings.fireconnectAddedModels = (stale.aiSettings.fireconnectAddedModels ?? [])
        .filter((id) => id !== "nexus/auto");
      writeCursorDb(dbPath, stale);

      const rerun = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(rerun.code, 0, `stderr: ${rerun.stderr}`);

      const blob = readBlob(dbPath);
      assert.ok(blob.aiSettings.userAddedModels.includes("nexus/auto"), "nexus/auto backfilled into userAddedModels");
      assert.ok((blob.aiSettings.fireconnectAddedModels ?? []).includes("nexus/auto"), "nexus/auto tracked as fireconnect-owned");
      assert.ok(blob.aiSettings.modelOverrideEnabled.includes("nexus/auto"), "nexus/auto enabled in the picker");
    });
  });

  itIfSqlite("on overrides a key the user cleared in the IDE (empty ciphertext in secret cell)", async () => {
    // Regression: modern Cursor reads the encrypted `secret://cursorAuth/openAIKey`
    // cell and writes an empty ciphertext there when the user removes the key in
    // the IDE. A stale plaintext `cursorAuth/openAIKey` cell can't override that,
    // so `on` must write the encrypted cell — otherwise the cleared key wins and
    // Cursor keeps using no key despite `on` succeeding.
    await withTempHome("cursor-override-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob();
      blob.useOpenAIKey = true;
      blob.openAIBaseUrl = CURSOR_FIREWORKS_BASE_URL;
      // IDE-cleared key: empty safeStorage ciphertext in the secret cell.
      writeCursorDb(dbPath, blob, { openAIKey: "" });

      const r = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      assert.equal(decryptSecretCell(dbPath), "fw_test_key_12345");
    });
  });

  it("on works against a never-launched profile (missing state.vscdb)", async () => {
    await withTempHome("cursor-fresh-profile-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const r = await runCli(
        ["cursor", "on", "--api-key", "fw_cataloged_v1_adversarial000000", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const status = await runCliJson(["cursor", "status", "--db-path", dbPath, "--json"], { home });
      assert.equal(status.code, 0, `stderr: ${status.stderr}`);
      assert.equal(status.json.provider, "fireworks");
      assert.ok(status.json.registeredModels.includes("nexus/auto"));
    });
  });

  itIfSqlite("on sets every existing mode to the default model", async () => {
    await withTempHome("cursor-allmodes-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob();
      blob.aiSettings.modelConfig["cmd-k"] = { modelName: "old", selectedModels: [] };
      blob.aiSettings.modelConfig["background-composer"] = { modelName: "composer-2.5", selectedModels: [] };
      writeCursorDb(dbPath, blob);

      const r = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const after = readBlob(dbPath);
      assert.equal(after.aiSettings.modelConfig.composer.modelName, "nexus/auto");
      assert.equal(after.aiSettings.modelConfig["cmd-k"].modelName, "nexus/auto");
      assert.equal(after.aiSettings.modelConfig["background-composer"].modelName, "nexus/auto");
      // no new modes created beyond the three that existed
      assert.deepEqual(Object.keys(after.aiSettings.modelConfig).sort(), ["background-composer", "cmd-k", "composer"]);
    });
  });

  itIfSqlite("off round-trips: restores base url, useOpenAIKey, models, and clears key", async () => {
    await withTempHome("cursor-off-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      const r = await runCli(["cursor", "off", "--db-path", dbPath, "--force"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const blob = readBlob(dbPath);
      assert.equal(blob.openAIBaseUrl, null);
      assert.equal(blob.useOpenAIKey, false);
      assert.deepEqual(blob.aiSettings.userAddedModels, []);
      // Restore brings back the pre-`on` blob, which never had nexus's
      // tracker field — so it's absent (not an empty array).
      assert.equal(blob.aiSettings.fireconnectAddedModels, undefined);
      assert.equal(blob.aiSettings.modelConfig.composer.modelName, "default");
      // `off` matches Cursor's own "no key" shape: an empty safeStorage
      // ciphertext in the secret cell (not a deleted row); it decrypts to "".
      assert.equal(decryptSecretCell(dbPath), "");
    });
  });

  itIfSqlite("off preserves user-owned custom models", async () => {
    await withTempHome("cursor-preserve-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob();
      blob.aiSettings.userAddedModels.push("user-own-model");
      blob.aiSettings.modelOverrideEnabled.push("user-own-model");
      writeCursorDb(dbPath, blob);

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      await runCli(["cursor", "off", "--db-path", dbPath, "--force"], { home });

      const after = readBlob(dbPath);
      assert.ok(after.aiSettings.userAddedModels.includes("user-own-model"));
    });
  });

  itIfSqlite("status --json reports provider, base url, and active model without modes", async () => {
    await withTempHome("cursor-status-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      const r = await runCliJson(["cursor", "status", "--db-path", dbPath, "--json"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.harness, "cursor");
      assert.equal(r.json.provider, "fireworks");
      assert.equal(r.json.baseUrl, CURSOR_FIREWORKS_BASE_URL);
      assert.equal(r.json.hasKey, true);
      assert.equal(r.json.current.main, "nexus/auto");
      assert.equal(r.json.defaultMode, undefined);
      assert.equal(r.json.modes, undefined);
    });
  });

  itIfSqlite("on --model selects the requested model", async () => {
    await withTempHome("cursor-main-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const r = await runCli(
        [
          "cursor", "on", "--api-key", "fw_test_key_12345",
          "--model", "deepseek-v4-flash",
          "--db-path", dbPath, "--force",
        ],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const blob = readBlob(dbPath);
      assert.equal(
        blob.aiSettings.modelConfig.composer.modelName,
        "deepseek-v4-flash",
      );
      assert.ok(blob.aiSettings.userAddedModels.includes("deepseek-v4-flash"));
    });
  });

  itIfSqlite("re-on preserves selections while migrating legacy canonical refs", async () => {
    await withTempHome("cursor-reon-model-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob();
      blob.aiSettings.modelConfig.chat = {
        modelName: "default",
        selectedModels: [{ modelId: "default", parameters: [] }],
      };
      writeCursorDb(dbPath, blob);

      const first = await runCli(
        [
          "cursor", "on", "--api-key", "fw_test_key_12345",
          "--model", "deepseek-v4-flash", "--db-path", dbPath, "--force",
        ],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(first.code, 0, first.stderr);
      const beforeBlob = readBlob(dbPath);
      const before = structuredClone(beforeBlob.aiSettings.modelConfig);
      const canonical = "accounts/fireworks/models/deepseek-v4-flash";
      beforeBlob.aiSettings.userAddedModels = [canonical];
      beforeBlob.aiSettings.modelOverrideEnabled = [canonical];
      beforeBlob.aiSettings.fireconnectAddedModels = [canonical];
      for (const config of Object.values(beforeBlob.aiSettings.modelConfig)) {
        config.modelName = canonical;
        config.selectedModels = [{ modelId: canonical, parameters: [] }];
      }
      writeCursorDb(dbPath, beforeBlob);

      const second = await runCli(
        ["cursor", "on", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(second.code, 0, second.stderr);
      const after = readBlob(dbPath);
      assert.deepEqual(after.aiSettings.modelConfig, before);
      assert.ok(after.aiSettings.userAddedModels.includes("deepseek-v4-flash"));
      assert.ok(after.aiSettings.userAddedModels.every(
        (id) => !id.startsWith("accounts/fireworks/"),
      ));
      assert.ok(after.aiSettings.fireconnectAddedModels.every(
        (id) => !id.startsWith("accounts/fireworks/"),
      ));
    });
  });

  itIfSqlite("re-on replaces a Cursor-native selection (auto-smart) instead of preserving it", async () => {
    await withTempHome("cursor-reon-native-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      // "cataloged" key → mock gateway serves a catalog, exercising the online
      // path where pruning (not the offline trust set) applies.
      const first = await runCli(
        ["cursor", "on", "--api-key", "fw_test_cataloged_key_12345", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(first.code, 0, first.stderr);

      // Simulate the old buggy state: Cursor's native Auto id preserved and
      // registered as if it were a Fireworks model.
      const blob = readBlob(dbPath);
      blob.aiSettings.modelConfig.composer.modelName = "auto-smart";
      blob.aiSettings.modelConfig.composer.selectedModels = [{ modelId: "auto-smart", parameters: [] }];
      blob.aiSettings.userAddedModels.push("auto-smart");
      blob.aiSettings.modelOverrideEnabled.push("auto-smart");
      blob.aiSettings.fireconnectAddedModels.push("auto-smart");
      writeCursorDb(dbPath, blob);

      const second = await runCli(
        ["cursor", "on", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /Cursor → Fireworks · auto/);
      assert.match(second.stdout, /Built-in "auto-smart" isn't on Fireworks/);

      const after = readBlob(dbPath);
      assert.equal(after.aiSettings.modelConfig.composer.modelName, "nexus/auto");
      // the stale native registration is pruned, not re-preserved
      assert.ok(!after.aiSettings.fireconnectAddedModels.includes("auto-smart"));
      assert.ok(!after.aiSettings.userAddedModels.includes("auto-smart"));
      // and hidden from the picker
      assert.ok(after.aiSettings.modelOverrideDisabled.includes("auto-smart"));
    });
  });

  itIfSqlite("offline re-on drops retired rows a previous online run registered", async () => {
    await withTempHome("cursor-reon-offline-retired-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      // Plain key → mock gateway 404s the catalog → offline path.
      const first = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(first.code, 0, first.stderr);

      // A past online run registered retired rows and selected one.
      const blob = readBlob(dbPath);
      blob.aiSettings.fireconnectAddedModels.push("firerouter", "auto-instant");
      blob.aiSettings.userAddedModels.push("firerouter", "auto-instant");
      blob.aiSettings.modelOverrideEnabled.push("firerouter", "auto-instant");
      blob.aiSettings.modelConfig.composer.modelName = "firerouter";
      blob.aiSettings.modelConfig.composer.selectedModels = [{ modelId: "firerouter", parameters: [] }];
      writeCursorDb(dbPath, blob);

      const second = await runCli(
        ["cursor", "on", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(second.code, 0, second.stderr);

      const after = readBlob(dbPath);
      assert.equal(after.aiSettings.modelConfig.composer.modelName, "nexus/auto");
      for (const field of ["fireconnectAddedModels", "userAddedModels", "modelOverrideEnabled"]) {
        assert.ok(!after.aiSettings[field].some((id) => id.startsWith("firerouter") || id === "auto-instant"), `${field}: ${after.aiSettings[field]}`);
      }
    });
  });

  itIfSqlite("offline re-on keeps models a previous online run registered", async () => {
    await withTempHome("cursor-reon-offline-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      // Plain key → mock gateway 404s the catalog → offline path.
      const first = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(first.code, 0, first.stderr);

      // Pretend a past ONLINE run registered a catalog id the static spec
      // list doesn't know, and the user picked it — plus the legacy poison: a
      // Cursor-native id (in Cursor's own availableDefaultModels2) that an old
      // version registered by mistake.
      const blob = readBlob(dbPath);
      blob.availableDefaultModels2 = [{ name: "auto-smart" }, { name: "composer-2.5" }];
      blob.aiSettings.fireconnectAddedModels.push("future-fw-model", "auto-smart");
      blob.aiSettings.userAddedModels.push("future-fw-model", "auto-smart");
      blob.aiSettings.modelOverrideEnabled.push("future-fw-model");
      blob.aiSettings.modelConfig.composer.modelName = "future-fw-model";
      blob.aiSettings.modelConfig.composer.selectedModels = [{ modelId: "future-fw-model", parameters: [] }];
      writeCursorDb(dbPath, blob);

      const second = await runCli(
        ["cursor", "on", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /Cursor → Fireworks · future-fw-model/);
      assert.doesNotMatch(second.stdout, /isn't on Fireworks/);

      const after = readBlob(dbPath);
      assert.equal(after.aiSettings.modelConfig.composer.modelName, "future-fw-model");
      // trusted, not pruned or hidden
      assert.ok(after.aiSettings.fireconnectAddedModels.includes("future-fw-model"));
      assert.ok(after.aiSettings.userAddedModels.includes("future-fw-model"));
      assert.ok(!(after.aiSettings.modelOverrideDisabled ?? []).includes("future-fw-model"));
      // ...but the stale Cursor-native registration still self-heals offline
      assert.ok(!after.aiSettings.fireconnectAddedModels.includes("auto-smart"));
      assert.ok(!after.aiSettings.userAddedModels.includes("auto-smart"));
      assert.ok(after.aiSettings.modelOverrideDisabled.includes("auto-smart"));
    });
  });

  itIfSqlite("explicit --model still removes stale Cursor-native registrations", async () => {
    await withTempHome("cursor-explicit-prune-native-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const first = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(first.code, 0, first.stderr);

      const blob = readBlob(dbPath);
      blob.availableDefaultModels2 = [{ name: "auto-smart" }];
      blob.aiSettings.fireconnectAddedModels.push("auto-smart");
      blob.aiSettings.userAddedModels.push("auto-smart");
      writeCursorDb(dbPath, blob);

      const second = await runCli(
        [
          "cursor", "on", "--model", "deepseek-v4-flash",
          "--db-path", dbPath, "--force",
        ],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(second.code, 0, second.stderr);

      const after = readBlob(dbPath);
      assert.ok(!after.aiSettings.fireconnectAddedModels.includes("auto-smart"));
      assert.ok(!after.aiSettings.userAddedModels.includes("auto-smart"));
      assert.ok(after.aiSettings.modelOverrideDisabled.includes("auto-smart"));
      assert.ok(after.aiSettings.userAddedModels.includes("deepseek-v4-flash"));
    });
  });

  itIfSqlite("explicit --model switching away from a servable pick prints no native-model note", async () => {
    await withTempHome("cursor-reon-switch-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const apiKey = "fw_cataloged_v1_adversarial000000";

      const first = await runCli(
        ["cursor", "on", "--api-key", apiKey, "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(first.code, 0, first.stderr);

      // Simulate selecting another catalog model in Cursor.
      const blob = readBlob(dbPath);
      blob.aiSettings.modelConfig.composer.modelName = "kimi-latest";
      blob.aiSettings.modelConfig.composer.selectedModels = [{ modelId: "kimi-latest", parameters: [] }];
      writeCursorDb(dbPath, blob);

      const second = await runCli(
        ["cursor", "on", "--model", "deepseek-v4-flash", "--api-key", apiKey, "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /Cursor → Fireworks · deepseek-v4-flash/);
      assert.doesNotMatch(second.stdout, /isn't on Fireworks/);
      assert.equal(readBlob(dbPath).aiSettings.modelConfig.composer.modelName, "deepseek-v4-flash");
    });
  });

  itIfSqlite("on hides built-in models from the picker and off restores them", async () => {
    await withTempHome("cursor-hide-builtins-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob({
        availableDefaultModels2: [{ name: "auto-smart" }, { name: "composer-2.5" }],
      });
      writeCursorDb(dbPath, blob);

      const on = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(on.code, 0, on.stderr);

      const after = readBlob(dbPath);
      assert.ok(after.aiSettings.modelOverrideDisabled.includes("auto-smart"));
      assert.ok(after.aiSettings.modelOverrideDisabled.includes("composer-2.5"));

      const off = await runCli(
        ["cursor", "off", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(off.code, 0, off.stderr);
      const restored = readBlob(dbPath);
      // snapshot restore brings back the exact pre-on picker state
      assert.equal(restored.aiSettings.modelOverrideDisabled, undefined);
    });
  });

  itIfSqlite("env key wins over a stale harness-local key without being stored", async () => {
    await withTempHome("cursor-env-precedence-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob();
      blob.openAIBaseUrl = CURSOR_FIREWORKS_BASE_URL;
      blob.useOpenAIKey = true;
      writeCursorDb(dbPath, blob, { openAIKey: "fw_cursor_stale_local_key" });

      const envKey = "fw_cursor_env_key_123456789";
      const result = await runCli(
        ["cursor", "on", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: envKey } },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(decryptSecretCell(dbPath), envKey);
      await assert.rejects(access(path.join(home, ".nexus", ".secret-memory")));
    });
  });

  itIfSqlite("stored key wins over a stale harness-local key", async () => {
    await withTempHome("cursor-stored-precedence-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob();
      blob.openAIBaseUrl = CURSOR_FIREWORKS_BASE_URL;
      blob.useOpenAIKey = true;
      writeCursorDb(dbPath, blob, { openAIKey: "fw_cursor_stale_local_key" });
      const storedKey = "fw_cursor_stored_key_1234567";
      await seedKeychainConfig(home, storedKey);

      const result = await runCli(
        ["cursor", "on", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(decryptSecretCell(dbPath), storedKey);
    });
  });

  itIfSqlite("off restores pre-on per-mode model + base url + key (snapshot/restore)", async () => {
    await withTempHome("cursor-restore-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      // Pre-on: a non-default composer model, a non-Fireworks base url, and a
      // prior (non-Fireworks) key. `off` must recover these, not reset to default.
      const blob = baseBlob();
      blob.aiSettings.modelConfig.composer = {
        modelName: "user-prior-model",
        maxMode: true,
        selectedModels: [{ modelId: "user-prior-model", parameters: [] }],
      };
      blob.openAIBaseUrl = "https://prior.example/v1";
      writeCursorDb(dbPath, blob, { openAIKey: "sk-prior-key" });

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      const r = await runCli(["cursor", "off", "--db-path", dbPath, "--force"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const after = readBlob(dbPath);
      assert.equal(after.openAIBaseUrl, "https://prior.example/v1");
      assert.equal(after.useOpenAIKey, false);
      assert.equal(after.aiSettings.modelConfig.composer.modelName, "user-prior-model");
      assert.deepEqual(after.aiSettings.userAddedModels, []);
      assert.equal(after.aiSettings.fireconnectAddedModels, undefined);
      assert.equal(readKey(dbPath), "sk-prior-key");
    });
  });

  itIfSqlite("off with no backup strips fireconnect-managed settings only", async () => {
    await withTempHome("cursor-strip-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      // Fireworks already active but no backup file (e.g. enabled by an older
      // build). `off` must strip what nexus owns without throwing.
      const blob = baseBlob();
      blob.useOpenAIKey = true;
      blob.openAIBaseUrl = CURSOR_FIREWORKS_BASE_URL;
      blob.aiSettings.userAddedModels = ["accounts/fireworks/routers/glm-latest"];
      blob.aiSettings.modelOverrideEnabled = ["accounts/fireworks/routers/glm-latest"];
      blob.aiSettings.fireconnectAddedModels = ["accounts/fireworks/routers/glm-latest"];
      blob.aiSettings.fireconnectTouchedModes = ["composer"];
      writeCursorDb(dbPath, blob, { openAIKey: "fw_test_key_12345" });

      const r = await runCli(["cursor", "off", "--db-path", dbPath, "--force"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const after = readBlob(dbPath);
      assert.equal(after.useOpenAIKey, false);
      assert.equal(after.openAIBaseUrl, null);
      assert.deepEqual(after.aiSettings.userAddedModels, []);
      // `off` matches Cursor's own "no key" shape: an empty safeStorage
      // ciphertext in the secret cell (not a deleted row); it decrypts to "".
      assert.equal(decryptSecretCell(dbPath), "");
    });
  });

  itIfSqlite("status works against a missing DB (read-only, no throw)", async () => {
    await withTempHome("cursor-missing-", async (home) => {
      const dbPath = path.join(home, "does-not-exist.vscdb");
      const r = await runCliJson(["cursor", "status", "--db-path", dbPath, "--json"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.provider, "none");
      assert.equal(r.json.hasKey, false);

      const human = await runCli(["cursor", "status", "--db-path", dbPath], { home });
      assert.equal(human.code, 0, human.stderr);
      assert.match(human.stdout, /Auth: missing/);
    });
  });

  itIfSqlite("rejects firerouter in Cursor without writing the selection", async () => {
    await withTempHome("cursor-firerouter-no-key-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const result = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--model", "firerouter", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /is no longer supported/);
      assert.notEqual(cursorCurrentModelId(readBlob(dbPath), CURSOR_DEFAULT_MODE), "firerouter");
    });
  });

  itIfSqlite("plain cursor on prints no FireRouter note", async () => {
    await withTempHome("cursor-firerouter-footnote-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const result = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(result.code, 0, result.stderr);
      // Plain `on` never advertises FireRouter.
      assert.doesNotMatch(result.stdout, /FireRouter/);
    });
  });

  itIfSqlite("firerouter is rejected when azure is the configured provider", async () => {
    await withTempHome("cursor-azure-cfg-firerouter-", async (home) => {
      const configure = await runCli(
        [
          "configure", "--provider", "azure",
          "--base-url", "https://msft-fw-foundry-resource.services.ai.azure.com",
          "--api-key", "azure-test-key-1234567890",
        ],
        { home, env: { FIREWORKS_API_KEY: "", AZURE_API_KEY: "" } },
      );
      assert.equal(configure.code, 0, configure.stderr);
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const result = await runCli(
        [
          "cursor", "on", "--api-key", "fw_test_key_12345",
          "--model", "firerouter", "--db-path", dbPath, "--force",
        ],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--model firerouter is no longer supported\. Use --model auto instead/);
      assert.doesNotMatch(result.stderr, /needs workspace BYOK/);
    });
  });

  itIfSqlite("rejects a pure-Fireworks firerouter path in Cursor", async () => {
    await withTempHome("cursor-allow-firerouter-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const selectOn = await runCli(
        [
          "cursor", "on", "--api-key", "fw_test_key_12345",
          "--model", "firerouter/kimi-k3", "--db-path", dbPath, "--force",
        ],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.notEqual(selectOn.code, 0);
      assert.match(selectOn.stderr, /is no longer supported/);
      assert.notEqual(
        cursorCurrentModelId(readBlob(dbPath), CURSOR_DEFAULT_MODE),
        "firerouter/kimi-k3",
      );
    });
  });

  itIfSqlite("rejects firerouter selections with an Anthropic primary in Cursor", async () => {
    await withTempHome("cursor-refuse-anthropic-firerouter-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      for (const model of ["firerouter", "firerouter/claude-opus-5/kimi-k3-fast"]) {
        const result = await runCli(
          ["cursor", "on", "--api-key", "fw_test_key_12345",
            "--model", model, "--db-path", dbPath, "--force"],
          { home, env: { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } },
        );
        assert.notEqual(result.code, 0, model);
        assert.match(result.stderr, /is no longer supported/, model);
        assert.notEqual(cursorCurrentModelId(readBlob(dbPath), CURSOR_DEFAULT_MODE), model);
      }
    });
  });

  itIfSqlite("bare firerouter is rejected in Cursor even with no Anthropic key to forward", async () => {
    await withTempHome("cursor-firerouter-refused-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const result = await runCli(
        [
          "cursor", "on", "--api-key", "fw_test_key_12345",
          "--model", "firerouter", "--db-path", dbPath, "--force",
        ],
        { home, env: { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "sk-ant-configured-0000", OPENAI_API_KEY: "" } },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /is no longer supported/);
      assert.notEqual(cursorCurrentModelId(readBlob(dbPath), CURSOR_DEFAULT_MODE), "firerouter");
    });
  });

  itIfSqlite("on replaces a stale active firerouter model with the supported default", async () => {
    await withTempHome("cursor-recover-firerouter-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob({
        openAIBaseUrl: CURSOR_FIREWORKS_BASE_URL,
        useOpenAIKey: true,
        aiSettings: {
          userAddedModels: [FIREROUTER_ROUTER_ID],
          modelOverrideEnabled: [FIREROUTER_ROUTER_ID],
          fireconnectAddedModels: [FIREROUTER_ROUTER_ID],
          modelConfig: {
            composer: {
              modelName: FIREROUTER_ROUTER_ID,
              selectedModels: [{ modelId: FIREROUTER_ROUTER_ID, parameters: [] }],
            },
          },
        },
      });
      writeCursorDb(dbPath, blob, { openAIKey: "fw_test_key_12345" });

      const result = await runCli(
        ["cursor", "on", "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        cursorCurrentModelId(readBlob(dbPath), CURSOR_DEFAULT_MODE),
        "nexus/auto",
      );
    });
  });

});

describe("migrateCursorFirerouterOnUpgrade", () => {
  it("moves firerouter modes to nexus/auto and prunes rows (pure transform)", async () => {
    const blob = baseBlob({
      aiSettings: {
        userAddedModels: ["firerouter", "glm-latest", "accounts/fireworks/routers/firerouter"],
        modelOverrideEnabled: ["firerouter"],
        fireconnectAddedModels: ["firerouter", "glm-latest"],
        modelConfig: {
          composer: { modelName: "firerouter/astra", selectedModels: [{ modelId: "firerouter/astra", parameters: [] }] },
          "plan-execution": { modelName: "glm-latest", selectedModels: [{ modelId: "glm-latest", parameters: [] }] },
        },
      },
    });
    const { blob: next, changed } = dropCursorFirerouterSelection(blob);
    assert.equal(changed, true);
    assert.equal(cursorCurrentModelId(next, "composer"), "nexus/auto");
    assert.equal(cursorCurrentModelId(next, "plan-execution"), "glm-latest", "other modes untouched");
    assert.deepEqual(next.aiSettings.userAddedModels, ["glm-latest"]);
    assert.deepEqual(next.aiSettings.fireconnectAddedModels, ["glm-latest"]);
    assert.equal(dropCursorFirerouterSelection(next).changed, false, "idempotent");
  });

  itIfSqlite("rewrites the stored blob when routed, and skips when off", async () => {
    await withTempHome("cursor-firerouter-upgrade-", async (home) => {
      const { dbPath } = cursorPathsFor({ home });
      await mkdir(path.dirname(dbPath), { recursive: true });
      writeCursorDb(dbPath, baseBlob({
        openAIBaseUrl: CURSOR_FIREWORKS_BASE_URL,
        useOpenAIKey: true,
        aiSettings: {
          userAddedModels: ["firerouter"],
          modelOverrideEnabled: ["firerouter"],
          fireconnectAddedModels: ["firerouter"],
          modelConfig: {
            composer: { modelName: "firerouter", selectedModels: [{ modelId: "firerouter", parameters: [] }] },
          },
        },
      }), { openAIKey: "fw_test_key_12345" });
      await writeGlobalConfig(home, { harnesses: { cursor: { enabled: true, provider: "fireworks" } } });

      await assert.rejects(
        migrateCursorFirerouterOnUpgrade(home, { isRunning: () => true }),
        /Cursor is running/,
      );
      assert.equal(await migrateCursorFirerouterOnUpgrade(home, { isRunning: () => false }), true);
      const blob = readBlob(dbPath);
      assert.equal(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE), "nexus/auto");
      assert.deepEqual(blob.aiSettings.userAddedModels, []);

      assert.equal(await migrateCursorFirerouterOnUpgrade(home, { isRunning: () => false }), false);
    });
  });
});
