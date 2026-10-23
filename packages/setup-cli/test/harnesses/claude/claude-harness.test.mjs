import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  userSettingsPath,
  providerBackupPath,
  providerStatePath,
  resolveDataDir,
  syncFireworksModelDisplay,
  stripCustomModelOptionEnv,
} from "../../../lib/harnesses/claude/core.mjs";
import {
  fireworksModelPickerName,
  fireworksModelDisplayFields,
} from "../../../lib/harnesses/claude/picker-labels.mjs";
import { resolveClaudeAuthState } from "../../../lib/harnesses/claude/index.mjs";
import { migrateClaudeTelemetryOptOutsOnUpgrade } from "../../../lib/harnesses/claude/upgrade-migrations.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import {
  WEBSEARCH_MCP_SERVER_NAME,
  WEBSEARCH_MCP_URL,
  claudeJsonPath,
} from "../../../lib/system/websearch-state.mjs";
import {
  FIRECONNECT_REFERER,
  mockServerlessModel,
  mockServerlessModelRows,
  runFireconnect,
  withTempHome,
  writeClaudeSettings,
  assertClaudeNativeTierSlots,
} from "../../helpers.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { cacheServerlessCatalogSnapshot, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";

// Flat catalog rows that bind the `-latest` router aliases the defaults and
// picker labels resolve through. Alias routers come only from the API's per-row
// `aliases` field now, so offline/spawned tests must seed a snapshot.
const CATALOG_ROWS = [
  mockServerlessModel({
    name: "accounts/fireworks/models/glm-5p3",
    displayName: "GLM 5.3",
    aliases: ["accounts/fireworks/routers/glm-latest"],
  }),
  ...mockServerlessModelRows({
    name: "accounts/fireworks/models/glm-5p2",
    aliases: ["accounts/fireworks/routers/glm-fast-latest"],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    aliases: ["accounts/fireworks/routers/deepseek-flash-latest"],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    aliases: ["accounts/fireworks/routers/deepseek-pro-latest"],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/glm-5p3-flash",
    displayName: "GLM 5.3 Flash",
    input_modalities: ["text", "image"],
    aliases: ["accounts/fireworks/routers/glm-flash-latest"],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/kimi-k3",
    displayName: "Kimi K3",
    input_modalities: ["text", "image"],
    aliases: ["accounts/fireworks/routers/kimi-latest", "accounts/fireworks/routers/kimi-fast-latest"],
  }),
];

/** Persist the catalog to `home`'s scoped cache so a spawned CLI child reads it. */
function seedCatalogFor(home) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(CATALOG_ROWS));
  } finally {
    process.env.HOME = prevHome;
    // Keep this process's snapshot empty; in-process tests seed explicitly.
    setServerlessCatalogSnapshot(null);
  }
}

/** Run a synchronous in-process assertion with the alias catalog active. */
function withCatalog(fn) {
  setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(CATALOG_ROWS));
  try {
    return fn();
  } finally {
    setServerlessCatalogSnapshot(null);
  }
}

describe("claude harness integration", () => {
  it("uses active custom-header auth ahead of stale env and helper state", () => {
    const auth = resolveClaudeAuthState({
      apiKeyHelper: "/usr/local/bin/user-helper",
      env: {
        ANTHROPIC_API_KEY: "fw_stale_env_key",
        ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_active_header_key",
      },
    }, {
      authMode: "apiKeyHelper",
    });
    assert.deepEqual(auth, {
      authMode: "customHeader",
      keyConfigured: true,
      token: "fw_active_header_key",
    });
  });

  it("never keeps a legacy fpk_ key as Claude's Anthropic credential", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-legacy-fpk-"));
    seedCatalogFor(home);
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
          ANTHROPIC_API_KEY: "fpk_legacy_test_key_000000000000",
        },
      }),
    );

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_test_key_12345/);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
  });

  it("never disables Claude Code's updater, and re-on removes the pin an older version wrote", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-auto-update-"));
    seedCatalogFor(home);
    const settingsPath = userSettingsPath(home);
    const env = { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" };
    const on = async () => {
      const result = await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], env);
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(await readFile(settingsPath, "utf8"));
    };
    const updateKeys = [
      "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_AUTOUPDATER",
      "DISABLE_UPDATES",
    ];

    const fresh = await on();
    for (const key of updateKeys) {
      assert.equal(Object.hasOwn(fresh.env, key), false, `${key} must not be written`);
    }

    fresh.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE = "0";
    await writeFile(settingsPath, JSON.stringify(fresh));
    const cleaned = await on();
    assert.equal(Object.hasOwn(cleaned.env, "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE"), false);
  });

  it("re-on removes telemetry opt-outs an older version wrote, once", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-telemetry-"));
    seedCatalogFor(home);
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ env: { DO_NOT_TRACK: "1" } }));
    const env = { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" };
    const on = async () => {
      const result = await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], env);
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(await readFile(settingsPath, "utf8"));
    };

    // Recreate what an older `on` left: all three opt-outs and no marker.
    const connected = await on();
    connected.env.DISABLE_TELEMETRY = "1";
    connected.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    await writeFile(settingsPath, JSON.stringify(connected));
    const statePath = providerStatePath(resolveDataDir({ home }));
    const { retiredTelemetryOptOuts: marker, ...oldState } = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(marker, true, "every on records the cleanup, so a later update keeps user opt-outs");
    await writeFile(statePath, JSON.stringify(oldState));

    const cleaned = await on();
    assert.equal(Object.hasOwn(cleaned.env, "DISABLE_TELEMETRY"), false);
    assert.equal(Object.hasOwn(cleaned.env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"), false);
    assert.equal(cleaned.env.DO_NOT_TRACK, "1", "the user's own pre-Nexus value stays");

    // An opt-out added after the cleanup survives both re-on and the upgrade migration.
    cleaned.env.DISABLE_TELEMETRY = "1";
    await writeFile(settingsPath, JSON.stringify(cleaned));
    assert.equal((await on()).env.DISABLE_TELEMETRY, "1");
    assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), false);
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).env.DISABLE_TELEMETRY, "1");
  });

  it("on/off round-trip restores settings", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-"));
    seedCatalogFor(home);
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.env.ANTHROPIC_BASE_URL, "https://api.fireworks.ai/inference");
    // Gateway auth remains in X-Fireworks-Api-Key while Claude's native key is
    // preserved in its native env field.
    assert.equal(enabled.apiKeyHelper, undefined);
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_test_key_12345/);
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /User-Agent:/);
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-Title: Claude Code/);
    assert.ok(
      enabled.env.ANTHROPIC_CUSTOM_HEADERS.includes(`HTTP-Referer: ${FIRECONNECT_REFERER}`),
      enabled.env.ANTHROPIC_CUSTOM_HEADERS,
    );
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-FireRouter-Harness|Fireworks-Use-Case/);
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(enabled.model, "auto[1m]");
    assert.equal(enabled.env?.ANTHROPIC_MODEL, undefined);
    assert.equal(enabled.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
    assert.equal(enabled.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
    assert.equal(enabled.modelPicker?.fireconnectManaged, true);
    assert.equal(enabled.modelPicker?.replaceBuiltInOptions, false);
    const pickerModels = enabled.modelPicker?.options?.map((row) => row.model) ?? [];
    assert.ok(pickerModels.includes("auto[1m]"), pickerModels.join(", "));
    assert.ok(!pickerModels.includes("firerouter[1m]"), pickerModels.join(", "));
    assert.ok(pickerModels.includes("glm-latest[1m]"), pickerModels.join(", "));
    for (const key of ["DISABLE_TELEMETRY", "DO_NOT_TRACK", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
      assert.equal(Object.hasOwn(enabled.env, key), false, key);
    }
    assert.equal(enabled.env.ENABLE_TOOL_SEARCH, "true");
    assert.equal(Object.hasOwn(enabled.env, "CLAUDE_CODE_AUTO_MODE_SERVER"), false);
    assert.equal(enabled.env.CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP, "1");
    assert.equal(
      (await stat(settingsPath)).mode & 0o077,
      0,
      "settings.json must be owner-only while it contains the Fireworks key",
    );

    // The backup is a raw byte-for-byte snapshot of the original settings file
    // (like the other harnesses), so it must be owner-only (0600) — it holds the
    // user's pre-existing ANTHROPIC_API_KEY. (Masking with 0o077 distinguishes
    // 0600 from the 0644 default.)
    const backupPath = providerBackupPath(resolveDataDir({ home }));
    const backupStat = await stat(backupPath);
    assert.equal(backupStat.mode & 0o077, 0o000, "provider-backup.json should be owner-only (0600)");
    const backup = JSON.parse(await readFile(backupPath, "utf8"));
    assert.equal(backup.snapshot.existed, true);
    assert.equal(backup.configPath, settingsPath);
    assert.equal(JSON.parse(backup.snapshot.raw).env.ANTHROPIC_API_KEY, "sk-ant-original");

    const offResult = await runFireconnect(["claude", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(restored.apiKeyHelper, undefined);
    assert.equal(Object.hasOwn(restored.env, "DISABLE_TELEMETRY"), false);
    assert.equal(Object.hasOwn(restored.env, "ENABLE_TOOL_SEARCH"), false);
    assert.equal(Object.hasOwn(restored.env, "CLAUDE_CODE_AUTO_MODE_SERVER"), false);
    assert.equal(Object.hasOwn(restored.env, "CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP"), false);

    const config = await readGlobalConfig(home);
    assert.equal(config.harnesses.claude.enabled, false);
  });

  it("re-on drops the auto mode classifier pin an older version wrote", async () => {
    await withTempHome("claude-ams-legacy", async (home) => {
      seedCatalogFor(home);
      const env = { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" };
      const settingsPath = userSettingsPath(home);
      const first = await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], env);
      assert.equal(first.code, 0, first.stderr);
      const routed = JSON.parse(await readFile(settingsPath, "utf8"));
      routed.env.CLAUDE_CODE_AUTO_MODE_SERVER = "0";
      await writeFile(settingsPath, JSON.stringify(routed), { mode: 0o600 });

      const again = await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], env);
      assert.equal(again.code, 0, again.stderr);
      const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(Object.hasOwn(enabled.env, "CLAUDE_CODE_AUTO_MODE_SERVER"), false);
    });
  });

  it("keeps an auto mode classifier pin the user set before connecting", async () => {
    await withTempHome("claude-ams-own", async (home) => {
      seedCatalogFor(home);
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      const original = JSON.stringify({ env: { CLAUDE_CODE_AUTO_MODE_SERVER: "0" } });
      await writeFile(settingsPath, original);
      const env = { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" };

      const onResult = await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], env);
      assert.equal(onResult.code, 0, onResult.stderr);
      assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).env.CLAUDE_CODE_AUTO_MODE_SERVER, "0");

      const offResult = await runFireconnect(["claude", "off"], { HOME: home });
      assert.equal(offResult.code, 0, offResult.stderr);
      assert.equal(await readFile(settingsPath, "utf8"), original);
    });
  });

  it("rejects a firerouter compound model instead of adding a picker row", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-firerouter-compound-"));
    seedCatalogFor(home);
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345", "--model", "firerouter/astra"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.notEqual(onResult.code, 0);
    assert.match(onResult.stderr, /--model firerouter\/astra is no longer supported/);
    assert.equal(existsSync(settingsPath), false);
  });

  it("preserves native ANTHROPIC_AUTH_TOKEN and a user-owned apiKeyHelper", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-native-helper-"));
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      apiKeyHelper: "/usr/local/bin/user-anthropic-key-helper",
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-ant-native-auth-token",
      },
    }));

    const result = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(result.code, 0, result.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.apiKeyHelper, "/usr/local/bin/user-anthropic-key-helper");
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, "sk-ant-native-auth-token");
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(enabled.model, "auto[1m]");
    assert.equal(enabled.env?.ANTHROPIC_MODEL, undefined);
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
  });

  it("treats a non-managed user apiKeyHelper as native auth", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-helper-auth-"));
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      apiKeyHelper: "/usr/local/bin/user-anthropic-key-helper",
    }));

    const result = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(result.code, 0, result.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.apiKeyHelper, "/usr/local/bin/user-anthropic-key-helper");
    assert.equal(enabled.model, "auto[1m]");
    assert.equal(enabled.env?.ANTHROPIC_MODEL, undefined);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, undefined);
  });

  it("refuses --anthropic-api-key: Claude Code's own sign-in pays for Claude turns", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-anthropic-flag-"));
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", "fw_test_key_12345",
        "--anthropic-api-key", "sk-ant-native-flag",
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Claude Code's own login covers Claude turns/);
    assert.match(result.stderr, /claude login/);
    assert.equal(existsSync(userSettingsPath(home)), false);
    assert.equal((await readGlobalConfig(home)).anthropicApiKey, "");
  });

  it("never writes a saved or exported Anthropic key into Claude's settings", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-anthropic-saved-"));
    await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-saved-0000" });
    const result = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "sk-ant-exported-0000", ANTHROPIC_AUTH_TOKEN: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    const raw = await readFile(userSettingsPath(home), "utf8");
    assert.doesNotMatch(raw, /sk-ant-saved-0000|sk-ant-exported-0000/);
    assert.equal(JSON.parse(raw).model, "auto[1m]");
  });

  it("a re-on removes an Anthropic key an earlier on wrote, says so once, and off restores the original", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-anthropic-removed-"));
    const env = { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" };
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = '{"theme":"dark"}\n';
    await writeFile(settingsPath, original);
    const on = await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(on.code, 0, on.stderr);
    const legacy = JSON.parse(await readFile(settingsPath, "utf8"));
    legacy.env.ANTHROPIC_API_KEY = "sk-ant-written-by-old-on";
    await writeFile(settingsPath, JSON.stringify(legacy, null, 2));

    const reOn = await runFireconnect(["claude", "on"], env);
    assert.equal(reOn.code, 0, reOn.stderr);
    assert.match(reOn.stdout, /removed the one an earlier `nexus claude` saved/);
    assert.match(reOn.stdout, /claude login/);
    assert.doesNotMatch(await readFile(settingsPath, "utf8"), /sk-ant-written-by-old-on/);

    const again = await runFireconnect(["claude", "on"], env);
    assert.equal(again.code, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /removed the one an earlier/);

    const off = await runFireconnect(["claude", "off"], env);
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  });

  it("missing Fireworks auth stops before settings changes with login and custom SSO guidance", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-missing-fireworks-"));
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = '{"theme":"dark"}\n';
    await writeFile(settingsPath, original);

    const result = await runFireconnect(
      ["claude", "on"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /nexus login/);
    assert.match(result.stderr, /nexus login --account <account-id>/);
    assert.equal(await readFile(settingsPath, "utf8"), original);
    assert.equal((await readGlobalConfig(home)).anthropicApiKey, "");
    await assert.rejects(
      readFile(providerBackupPath(resolveDataDir({ home })), "utf8"),
      { code: "ENOENT" },
    );
  });

  it("on enables native WebSearch/WebFetch and removes the retired MCP", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-deny-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] } }),
    );
    await writeFile(claudeJsonPath(home), JSON.stringify({
      mcpServers: {
        "user-server": { command: "echo" },
        [WEBSEARCH_MCP_SERVER_NAME]: { type: "http", url: WEBSEARCH_MCP_URL },
      },
    }));

    for (const args of [
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      [
        "claude", "on",
        "--model", "glm-latest",
        "--api-key", "fw_test_key_12345",
      ],
    ]) {
      const on = await runFireconnect(args, {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      });
      assert.equal(on.code, 0, on.stderr);
      const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepEqual(
        enabled.permissions.deny,
        ["Bash(rm:*)"],
        `deny merged after ${args.join(" ")}`,
      );
      // The user's own allow rule is untouched.
      assert.deepEqual(enabled.permissions.allow, ["Bash(ls:*)"]);
      const claudeJson = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
      assert.deepEqual(claudeJson.mcpServers, { "user-server": { command: "echo" } });

      const off = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(off.code, 0, off.stderr);
      const restored = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepEqual(restored.permissions.deny, ["Bash(rm:*)"], `deny restored after ${args.join(" ")}`);
    }
  });

  it("on retires an already-connected pre-0.9.7 profile's MCP and tool denials", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-upgrade-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const settingsPath = userSettingsPath(home);
    const original = JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] },
    });
    await writeFile(settingsPath, original);

    const first = await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    });
    assert.equal(first.code, 0, first.stderr);

    // Recreate what FireConnect <= 0.9.6 left behind on a connected profile:
    // the managed websearch MCP plus both server-tool denials.
    const connected = JSON.parse(await readFile(settingsPath, "utf8"));
    connected.permissions.deny = ["Bash(rm:*)", "WebSearch", "WebFetch"];
    await writeFile(settingsPath, JSON.stringify(connected));
    await writeFile(claudeJsonPath(home), JSON.stringify({
      mcpServers: {
        "user-server": { command: "echo" },
        [WEBSEARCH_MCP_SERVER_NAME]: {
          type: "http",
          url: WEBSEARCH_MCP_URL,
          headers: { Authorization: "Bearer fw_test_key_12345" },
        },
      },
    }));

    const upgraded = await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    });
    assert.equal(upgraded.code, 0, upgraded.stderr);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(settings.permissions.deny, ["Bash(rm:*)"]);
    assert.deepEqual(settings.permissions.allow, ["Bash(ls:*)"]);
    const claudeJson = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
    assert.deepEqual(claudeJson.mcpServers, { "user-server": { command: "echo" } });

    const off = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  });

  it("on/off restores the settings file byte-for-byte (formatting, order, unrelated keys)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-byte4byte-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const settingsPath = userSettingsPath(home);
    // Idiosyncratic formatting (4-space indent, trailing newline) + user-only
    // keys Nexus doesn't manage. A surgical/key-level backup would reformat
    // this; a raw snapshot restores it exactly.
    const original = `{
    "permissions": { "allow": ["Bash(ls:*)"] },
    "env": {
        "ANTHROPIC_API_KEY": "sk-ant-user-original",
        "CLAUDE_CODE_ATTRIBUTION_HEADER": "1",
        "MY_CUSTOM_VAR": "keep-me"
    },
    "model": "opus"
}
`;
    await writeFile(settingsPath, original);

    for (const args of [["claude", "on", "--api-key", "fw_test_key_12345"], ["claude", "on", "--model", "glm-latest", "--api-key", "fw_test_key_12345"]]) {
      const on = await runFireconnect(args, { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(on.code, 0, on.stderr);
      const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(enabled.env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined);
      const off = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(off.code, 0, off.stderr);
      assert.equal(await readFile(settingsPath, "utf8"), original, `byte-for-byte after ${args.join(" ")}`);
    }
  });

  it("on --api-key persists to keychain for key export", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-keychain-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const apiKey = "fw_test_key_12345";

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", apiKey],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const { readGlobalConfig } = await import("../../../lib/config/global-config.mjs");
    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, "{keychain:fireworks-api-key}");

    const exportResult = await runFireconnect(["key", "export"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(exportResult.code, 0, exportResult.stderr);
    assert.equal(exportResult.stdout.trim(), apiKey);
  });

  it("on persists harness-local Fireworks key to the keychain and uses the custom header", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-harness-local-"));
    const harnessKey = "fw_claude_harness_only_key123";
    await writeClaudeSettings(home, harnessKey);
    const settingsPath = userSettingsPath(home);

    const onResult = await runFireconnect(["claude", "on"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    });
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.apiKeyHelper, undefined);
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_claude_harness_only_key123/);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, undefined);

    const exportResult = await runFireconnect(["key", "export"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(exportResult.code, 0, exportResult.stderr);
    assert.equal(exportResult.stdout.trim(), harnessKey);
  });

  it("on does not clobber a newer stored key with a stale baked key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-clobber-"));
    const newKey = "fw_new_login_key_000000000000000000";
    const staleKey = "fw_old_baked_key_000000000000000000";
    const settingsPath = userSettingsPath(home);

    // Store + bake the current key (like a `login` followed by `claude on`).
    const first = await runFireconnect(["claude", "on", "--api-key", newKey], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(first.code, 0, first.stderr);

    // Simulate a stale key still baked into settings by an earlier `on`.
    const stale = JSON.parse(await readFile(settingsPath, "utf8"));
    stale.env.ANTHROPIC_CUSTOM_HEADERS = `X-Fireworks-Api-Key: ${staleKey}`;
    await writeFile(settingsPath, JSON.stringify(stale));

    // Re-enable with no flag: the stored key must win and never be overwritten
    // by the stale baked header.
    const second = await runFireconnect(["claude", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(second.code, 0, second.stderr);

    const exportResult = await runFireconnect(["key", "export"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(exportResult.stdout.trim(), newKey, "stored key must survive re-enable");

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, new RegExp(`X-Fireworks-Api-Key: ${newKey}`));
  });

  it("on pre-approves a stray ANTHROPIC_API_KEY so Claude Code doesn't prompt", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-approve-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const strayKey = "sk-ant-api03-STRAYstrayKEY1234567890";

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: strayKey },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    // Claude Code identifies an approved key by key.trim().slice(-20).
    const claudeJson = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
    assert.ok(
      claudeJson.customApiKeyResponses.approved.includes(strayKey.slice(-20)),
      "the stray key's last-20 identifier should be pre-approved",
    );
  });

  it("off without on leaves user settings unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-off-noop-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    const originalSettings = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-original",
      },
    });
    await writeFile(settingsPath, originalSettings);

    const offResult = await runFireconnect(["claude", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const after = await readFile(settingsPath, "utf8");
    assert.equal(after, originalSettings);
  });

  it("second off after on/off round-trip leaves settings unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-double-off-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    await runFireconnect(["claude", "off"], { HOME: home });

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");

    await runFireconnect(["claude", "off"], { HOME: home });

    const afterSecondOff = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(afterSecondOff.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(afterSecondOff.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  });

  it("prints one compact warning for text-only models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-vision-warn-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", "fw_test_key_12345",
        "--model", "glm-fast-latest",
      ],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Text-only: glm-fast-latest · Avoid images; recover with \/rewind\./,
    );
    assert.doesNotMatch(result.stdout, /Claude Code cannot mark models as text-only/);
  });

  it("status shows Cursor-style model and registered models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-vision-status-"));
    seedCatalogFor(home);
    const onResult = await runFireconnect(
      [
        "claude", "on",
        "--api-key", "fw_test_key_12345",
        "--model", "glm-fast-latest",
      ],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const statusResult = await runFireconnect(["claude", "status"], { HOME: home });
    assert.equal(statusResult.code, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /^Model: glm-fast-latest$/m);
    assert.match(statusResult.stdout, /^Registered models:$/m);
    assert.match(statusResult.stdout, /^\s+glm-fast-latest$/m);
    assert.match(statusResult.stdout, /^\s+deepseek-flash-latest$/m);
    assert.doesNotMatch(statusResult.stdout, /Model mapping/);
    assert.doesNotMatch(statusResult.stdout, /Using Anthropic/);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.model, "glm-fast-latest[1m]");
    assertClaudeNativeTierSlots(settings);
  });
});

describe("fireworksModelPickerName", () => {
  it("uses catalog labels instead of raw slugs for subscription picker names", () => {
    withCatalog(() => {
      assert.equal(fireworksModelPickerName("glm-fast-latest"), "GLM 5.2 Fast (Latest)");
      assert.equal(fireworksModelPickerName("kimi-fast-latest"), "Kimi K3 Fast (Latest)");
      assert.equal(fireworksModelPickerName("deepseek-v4-flash"), "DeepSeek V4 Flash");
      assert.equal(fireworksModelPickerName("firerouter"), "Auto");
    });
  });

  it("strips ' via Fireworks' from cached catalog pricing labels", () => {
    // A fast-mode row whose display name still carries the API's " via
    // Fireworks" suffix: the snapshot builder must strip it from the pricing
    // label the alias borrows.
    const snapshot = buildServerlessCatalogSnapshot([
      ...mockServerlessModelRows({
        name: "accounts/fireworks/models/glm-5p2",
        displayName: "GLM 5.2 Fast via Fireworks",
        aliases: ["accounts/fireworks/routers/glm-fast-latest"],
      }),
    ]);
    setServerlessCatalogSnapshot(snapshot);
    try {
      assert.equal(fireworksModelPickerName("glm-fast-latest"), "GLM 5.2 Fast (Latest)");
      const fields = fireworksModelDisplayFields("glm-fast-latest", "ANTHROPIC_DEFAULT_FABLE_MODEL");
      assert.equal(fields.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, "GLM 5.2 Fast (Latest)");
      assert.doesNotMatch(fields.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION, / via Fireworks/);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("uses live catalog base model names ahead of stale static alias specs", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k2p8-code",
        shortId: "kimi-k2p8-code",
        displayName: "Kimi K2.8 Code",
        kind: "serverless",
      }],
      pricingById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", {
          slug: "kimi-fast-latest",
          label: "Kimi Fast Latest via Fireworks",
          input: 1.9,
          cachedInput: 0.38,
          output: 8,
          tier: "fast",
          source: "https://fireworks.ai/pricing",
        }],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k2p8-code"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(fireworksModelPickerName("kimi-fast-latest"), "Kimi K2.8 Code Fast (Latest)");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("writes pretty display fields for every alias slot", () => {
    withCatalog(() => {
      const mapping = {
        main: "firerouter",
        opus: "glm-fast-latest",
        sonnet: "glm-fast-latest",
        haiku: "deepseek-v4-flash",
        fable: "kimi-fast-latest",
        subagent: "deepseek-v4-flash",
      };
      const env = syncFireworksModelDisplay({}, mapping);
      assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "GLM 5.2 Fast (Latest)");
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, "GLM 5.2 Fast (Latest)");
      assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, "DeepSeek V4 Flash");
      assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, "Kimi K3 Fast (Latest)");
      assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
      assert.match(env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION, /Fireworks serverless · .*per Mtok/);
    });
  });

  it("strips ANTHROPIC_CUSTOM_MODEL_OPTION from subscription picker env", () => {
    const env = stripCustomModelOptionEnv({
      ANTHROPIC_CUSTOM_MODEL_OPTION: "firerouter[1m]",
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "FireRouter",
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "GLM 5.2 Fast",
    });
    assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
    assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, undefined);
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "GLM 5.2 Fast");
  });

  it("builds per-slot display fields from env prefix", () => {
    withCatalog(() => {
      const opus = fireworksModelDisplayFields("glm-fast-latest", "ANTHROPIC_DEFAULT_OPUS_MODEL");
      assert.equal(opus.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "GLM 5.2 Fast (Latest)");
      assert.match(opus.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION, /per Mtok/);
    });
  });
});
