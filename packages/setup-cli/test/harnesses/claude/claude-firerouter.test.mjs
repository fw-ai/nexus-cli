import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  providerBackupPath,
  userSettingsPath,
} from "../../../lib/harnesses/claude/core.mjs";
import { refreshFirerouterClaudeKey } from "../../../lib/harnesses/claude/firerouter.mjs";
import { readJsonIfExists, writeJson } from "../../../lib/io/json.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { cacheServerlessCatalogSnapshot, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  FIRECONNECT_REFERER,
  mockServerlessModel,
  runFireconnect,
  assertClaudeNativeTierSlots,
  assertClaudeRegisterablePicker,
} from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_test_key_12345";
const ANTHROPIC_KEY = "sk-ant-test-12345";
const FIREROUTER_MODEL = "firerouter[1m]";

/** Persist the alias catalog a spawned CLI child resolves defaults through. */
function seedCatalogFor(home) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/glm-5p3",
        displayName: "GLM 5.3",
        aliases: ["accounts/fireworks/routers/glm-latest"],
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        aliases: ["accounts/fireworks/routers/deepseek-flash-latest"],
      }),
    ]));
  } finally {
    process.env.HOME = prevHome;
    setServerlessCatalogSnapshot(null);
  }
}

function cliEnv(home) {
  return {
    HOME: home,
    FIREWORKS_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    OPENAI_API_KEY: "",
  };
}

describe("Claude FireRouter via --model", () => {
  it("rejects --model firerouter and writes nothing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-router-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "firerouter",
      ],
      cliEnv(home),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--model firerouter is no longer supported/);
    assert.equal(existsSync(userSettingsPath(home)), false);
  });

  it("rejects FireRouter compounds and full router ids, with or without BYOK flags", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-router-reject-"));
    seedCatalogFor(home);
    for (const args of [
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--model", "firerouter", "--openai-api-key", "sk-proj-claude-12345"],
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--model", "firerouter/gpt-5p6", "--openai-api-key", "sk-proj-claude-gpt-12345"],
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--model", "firerouter/opus", "--openai-api-key", "sk-proj-claude-opus-12345"],
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--model", "accounts/fireworks/routers/firerouter"],
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--opus", "firerouter/opus"],
    ]) {
      const result = await runFireconnect(args, cliEnv(home));
      assert.notEqual(result.code, 0, args.join(" "));
      assert.match(result.stderr, /is no longer supported/, args.join(" "));
    }
    assert.equal(existsSync(userSettingsPath(home)), false);
  });

  it("allows a plain on without detecting native auth", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-auth-optional-"));
    seedCatalogFor(home);
    const settingsPath = userSettingsPath(home);
    const dataDir = path.join(home, ".nexus/claude");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = '{"theme":"dark"}\n';
    await writeFile(settingsPath, original);

    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
      ],
      cliEnv(home),
    );

    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.model, "auto[1m]");
    assertClaudeNativeTierSlots(settings);
    assertClaudeRegisterablePicker(settings, { includes: ["auto[1m]"], excludes: [FIREROUTER_MODEL] });
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.notDeepEqual(await readJsonIfExists(providerBackupPath(dataDir)), {});
  });

  it("keeps an Anthropic key the user set in Claude's settings before FireConnect", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-native-key-"));
    await writeJson(userSettingsPath(home), { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
    const result = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.doesNotMatch(result.stdout, /FireRouter off|removed the one/);
  });

  it("pins per-tier slot flags on a plain on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slot-firerouter-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--sonnet", "glm-latest",
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.match(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, /glm-latest/);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_test_key_12345/);
  });

  it("plain re-on preserves picker and refuses an Anthropic key flag", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-reon-"));
    seedCatalogFor(home);
    const env = cliEnv(home);
    const first = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
      ],
      env,
    );
    assert.equal(first.code, 0, first.stderr);

    const reon = await runFireconnect(["claude", "on"], env);
    assert.equal(reon.code, 0, reon.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assertClaudeNativeTierSlots(settings);
    assertClaudeRegisterablePicker(settings, { includes: ["auto[1m]"], excludes: [FIREROUTER_MODEL] });

    const before = await readFile(userSettingsPath(home), "utf8");
    const byok = await runFireconnect(
      ["claude", "on", "--anthropic-api-key", ANTHROPIC_KEY],
      env,
    );
    assert.notEqual(byok.code, 0);
    assert.match(byok.stderr, /Claude Code's own login covers Claude turns/);
    assert.equal(await readFile(userSettingsPath(home), "utf8"), before);
  });

  it("off restores the original settings byte-for-byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-off-"));
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify({
      model: "sonnet",
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-original",
      },
    }, null, 2)}\n`;
    await writeFile(settingsPath, original);

    const on = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY],
      cliEnv(home),
    );
    assert.equal(on.code, 0, on.stderr);
    const off = await runFireconnect(["claude", "off"], cliEnv(home));
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  });

  it("plain re-on drops a stored FireRouter default from the picker and moves it to auto", async () => {
    const modelHome = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-router-reon-"));
    seedCatalogFor(modelHome);
    // What an earlier release wrote for `claude on --model firerouter`.
    await writeJson(userSettingsPath(modelHome), {
      model: FIREROUTER_MODEL,
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${FIREWORKS_KEY}\nX-Title: Claude Code\nHTTP-Referer: ${FIRECONNECT_REFERER}`,
      },
      modelPicker: {
        fireconnectManaged: true,
        replaceBuiltInOptions: false,
        options: [
          { model: FIREROUTER_MODEL, label: "FireRouter", description: "old" },
          { model: "glm-latest[1m]", label: "GLM", description: "old" },
        ],
      },
    });

    const reon = await runFireconnect(["claude", "on"], cliEnv(modelHome));
    assert.equal(reon.code, 0, reon.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(modelHome), "utf8"));
    assert.equal(settings.model, "auto[1m]");
    assertClaudeRegisterablePicker(settings, { includes: ["auto[1m]"], excludes: [FIREROUTER_MODEL] });
  });

  it("refreshes the baked Fireworks key for firerouter headers", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-key-refresh-"));
    const settingsPath = userSettingsPath(home);
    await writeJson(settingsPath, {
      env: {
        ANTHROPIC_CUSTOM_HEADERS:
          "X-Fireworks-Api-Key: fw_old_key\nx-anthropic-api-key: sk-ant-keep",
      },
    });
    assert.equal(
      await refreshFirerouterClaudeKey({ settingsPath, fireworksKey: "fw_new_key" }),
      true,
    );
    const headers = (await readJsonIfExists(settingsPath)).env.ANTHROPIC_CUSTOM_HEADERS;
    assert.match(headers, /X-Fireworks-Api-Key: fw_new_key/);
    assert.match(headers, /x-anthropic-api-key: sk-ant-keep/);
  });

  it("preserves the original backup across repeat connect", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-backup-"));
    const settingsPath = userSettingsPath(home);
    const dataDir = path.join(home, ".nexus/claude");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = '{"model":"sonnet"}\n';
    await writeFile(settingsPath, original);

    assert.equal(
      (await runFireconnect(
        [
          "claude", "on",
          "--api-key", FIREWORKS_KEY,
        ],
        cliEnv(home),
      )).code,
      0,
    );
    assert.equal(
      (await runFireconnect(["claude", "on"], cliEnv(home))).code,
      0,
    );
    const backup = await readJsonIfExists(providerBackupPath(dataDir));
    assert.equal(backup.snapshot.raw, original);
  });

  it("re-on strips a routing-preference header left by an earlier release", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-retired-routing-"));
    const env = cliEnv(home);
    const on = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY],
      env,
    );
    assert.equal(on.code, 0, on.stderr);
    const settingsPath = userSettingsPath(home);
    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    written.env.ANTHROPIC_CUSTOM_HEADERS += "\nx-routing-preference: 1";
    await writeJson(settingsPath, written);

    const reon = await runFireconnect(["claude", "on"], env);
    assert.equal(reon.code, 0, reon.stderr);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-routing-preference/i);
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: /);

    const status = await runFireconnect(["claude", "status"], env);
    assert.equal(status.code, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /Routing:/);
    const jsonStatus = await runFireconnect(["claude", "status", "--json"], env);
    assert.equal(jsonStatus.code, 0, jsonStatus.stderr);
    assert.equal("routingPreference" in JSON.parse(jsonStatus.stdout), false);
  });
});
