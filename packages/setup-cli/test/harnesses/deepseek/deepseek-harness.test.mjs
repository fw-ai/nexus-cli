import { mkdtemp, readFile, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deepseekBackupPath,
  deepseekCredentialsPath,
  deepseekCurrentModelId,
  deepseekDataDir,
  enableDeepseekFireworks,
  migrateDeepseekFirerouterModel,
  deepseekSettingsPath,
  buildDeepseekFireworksModelEntry,
  patchDeepseekFireworksSettings,
  patchDeepseekProfilePatchEntries,
  stripDeepseekProfilePatchEntries,
  readDeepseekSettingsIfExists,
} from "../../../lib/harnesses/deepseek/core.mjs";
import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { lookupFireworksModelLimits } from "../../../lib/fireworks/model-specs.mjs";
import { readJsonIfExists } from "../../../lib/io/json.mjs";
import { resetSecretStoreForTests } from "../../../lib/keys/secret-store.mjs";
import {
  runFireconnect,
  seedKeychainConfig,
} from "../../helpers.mjs";

describe("buildDeepseekFireworksModelEntry catalog metadata", () => {
  it("registers firerouter with shared catalog limits", () => {
    const entry = buildDeepseekFireworksModelEntry("firerouter", "FireRouter");
    const limits = lookupFireworksModelLimits("firerouter");

    assert.equal(entry.id, "firerouter");
    assert.equal(entry.contextWindow, limits.contextWindow);
    assert.equal(entry.maxTokens, limits.maxTokens);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.reasoning, true);
  });

  it("registers serverless models with shared catalog limits", () => {
    const entry = buildDeepseekFireworksModelEntry("deepseek-v4-flash", "DeepSeek V4 Flash");
    const limits = lookupFireworksModelLimits("deepseek-v4-flash");

    assert.equal(entry.id, "deepseek-v4-flash");
    assert.equal(entry.contextWindow, limits.contextWindow);
    assert.equal(entry.maxTokens, limits.maxTokens);
  });
});

describe("patchDeepseekFireworksSettings catalog metadata", () => {
  it("wires the deepseek wrapper into settings.yaml model rows", () => {
    const patched = patchDeepseekFireworksSettings({}, { modelId: "firerouter" });
    const entry = patched["llm-pi-ai"].providers.fireworks.models[0];
    assert.equal(entry.id, "firerouter");
    assert.equal(entry.contextWindow, 1_048_575);
    assert.deepEqual(entry.input, ["text", "image"]);
  });

  it("carries per-provider headers and drops them again without", () => {
    // dsh's llm-pi-ai provider profile carries a `headers` dict that is
    // sent on every request for that provider.
    const headers = { "x-nexus-providers": "fireworks", "X-Title": "DeepSeek Harness" };
    const patched = patchDeepseekFireworksSettings({}, { modelId: "auto", headers });
    assert.deepEqual(patched["llm-pi-ai"].providers.fireworks.headers, headers);

    const entries = patchDeepseekProfilePatchEntries([], { modelId: "auto", headers });
    const llmEntry = entries.find((entry) => entry.id === "llm-pi-ai");
    assert.deepEqual(llmEntry.config.providers.fireworks.headers, headers);

    const without = patchDeepseekFireworksSettings(patched, { modelId: "auto" });
    assert.equal(without["llm-pi-ai"].providers.fireworks.headers, undefined);
  });
});

describe("deepseek harness integration", () => {
  it("rejects an explicit firerouter selection", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-firerouter-manual-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    const result = await runFireconnect(
      [
        "deepseek",
        "on",
        "--api-key",
        "fw_test_key_12345",
        "--model",
        "accounts/fireworks/routers/firerouter",
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /is no longer supported/);
    const { settings } = await readDeepseekSettingsIfExists(deepseekSettingsPath(home));
    assert.equal(deepseekCurrentModelId(settings), null);
  });

  it("rejects bare firerouter without a forwardable Anthropic key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-firerouter-refused-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    const result = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "firerouter"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /is no longer supported/);
    const { settings } = await readDeepseekSettingsIfExists(deepseekSettingsPath(home));
    assert.equal(deepseekCurrentModelId(settings), null);
  });

  it("on/off round-trip restores settings.yaml and credentials.yaml", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    const settingsPath = deepseekSettingsPath(home);
    const credentialsPath = deepseekCredentialsPath(home);
    const originalSettings = [
      "theme:",
      "  mode: dark",
      "",
    ].join("\n");
    const originalCredentials = [
      "DEEPSEEK_API_KEY: sk-deepseek-test",
      "",
    ].join("\n");
    await writeFile(settingsPath, originalSettings);
    await writeFile(credentialsPath, originalCredentials);

    const onResult = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabledSettings = await readFile(settingsPath, "utf8");
    assert.match(enabledSettings, /provider: fireworks/);
    assert.match(enabledSettings, /apiKeyEnv: FIREWORKS_API_KEY/);
    assert.match(enabledSettings, /baseURL: https:\/\/api\.fireworks\.ai\/inference\/v1/);
    assert.match(enabledSettings, /auto/);
    assert.match(enabledSettings, /mode: dark/);

    const enabledCredentials = await readFile(credentialsPath, "utf8");
    assert.match(enabledCredentials, /FIREWORKS_API_KEY: fw_test_key_12345/);
    assert.match(enabledCredentials, /DEEPSEEK_API_KEY: sk-deepseek-test/);

    const offResult = await runFireconnect(["deepseek", "off"], { HOME: home });
    assert.equal(offResult.code, 0, offResult.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    assert.equal(await readFile(credentialsPath, "utf8"), originalCredentials);
  });

  it("on bakes keychain key into credentials", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-keychain-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");
    const onResult = await runFireconnect(["deepseek", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0, onResult.stderr);
    assert.match(onResult.stdout, /DeepSeek Harness → Fireworks · auto/);

    const credentials = await readFile(deepseekCredentialsPath(home), "utf8");
    assert.match(credentials, /FIREWORKS_API_KEY: fw_test_key_12345/);
  });

  it("on reuses baked credentials when global config and env are unset", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-reuse-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    const first = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "deepseek-v4-flash"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);

    await writeGlobalConfig(home, { apiKey: "" });
    resetSecretStoreForTests();

    const second = await runFireconnect(
      ["deepseek", "on", "--model", "kimi-fast-latest"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(second.code, 0, second.stderr);
    assert.match(await readFile(deepseekSettingsPath(home), "utf8"), /kimi-fast-latest/);
    assert.match(
      await readFile(deepseekCredentialsPath(home), "utf8"),
      /FIREWORKS_API_KEY: fw_test_key_12345/,
    );
  });

  it("status reports fireworks provider and model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-status-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    const on = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "deepseek-v4-flash"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const status = await runFireconnect(
      ["deepseek", "status", "--json"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(status.code, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.harness, "deepseek");
    assert.equal(payload.provider, "fireworks");
    assert.equal(payload.current.main, "deepseek-v4-flash");
    assert.equal(payload.hasAuthToken, true);

    const backupPath = deepseekBackupPath(deepseekDataDir(home), deepseekSettingsPath(home));
    assert.equal((await readJsonIfExists(backupPath)).settingsSnapshot !== undefined, true);

    const off = await runFireconnect(["deepseek", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    const after = await runFireconnect(["deepseek", "status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(after.code, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).provider, null);
  });
});

describe("deepseek profile patch (dsh 0.1.7+)", () => {
  it("patch entries upsert fireworks provider and default model, preserving others", () => {
    const entries = [
      { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: { other: { api: "mock" } } } },
      { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model", config: { provider: "other", model: "x" } },
    ];
    const next = patchDeepseekProfilePatchEntries(entries, { modelId: "glm-fast-latest" });
    const llm = next.find((entry) => entry.id === "llm-pi-ai");
    assert.ok(llm.config.providers.other, "user provider preserved");
    assert.equal(llm.config.providers.fireworks.baseURL, "https://api.fireworks.ai/inference/v1");
    assert.equal(llm.config.providers.fireworks.models[0].id, "glm-fast-latest");
    const def = next.find((entry) => entry.id === "agent-default-model");
    assert.equal(def.config.provider, "fireworks");
    assert.equal(def.config.model, "glm-fast-latest");
  });

  it("patch entries append when missing", () => {
    const next = patchDeepseekProfilePatchEntries([], { modelId: "firerouter" });
    assert.equal(next.length, 2);
    assert.equal(next[0].id, "llm-pi-ai");
    assert.equal(next[1].id, "agent-default-model");
  });

  it("strip removes only FireConnect-owned patch entries", () => {
    const entries = patchDeepseekProfilePatchEntries(
      [{ id: "llm-pi-ai", config: { providers: { other: { api: "mock" } } } }],
      { modelId: "glm-fast-latest" },
    );
    const { entries: stripped, changed } = stripDeepseekProfilePatchEntries(entries);
    assert.equal(changed, true);
    const llm = stripped.find((entry) => entry.id === "llm-pi-ai");
    assert.deepEqual(llm.config.providers, { other: { api: "mock" } });
    assert.ok(!stripped.some((entry) => entry.id === "agent-default-model"));
    // A user's own deepseek-official default is never stripped.
    const userDefault = [{ id: "agent-default-model", config: { provider: "deepseek-official", model: "deepseek-flash" } }];
    const again = stripDeepseekProfilePatchEntries(userDefault);
    assert.equal(again.changed, false);
    assert.equal(again.entries.length, 1);
  });

  it("on writes the profile patch when a profile exists; off restores it byte-for-byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-profile-"));
    await mkdir(path.join(home, ".dsh", "profiles", "headless"), { recursive: true });
    await writeFile(path.join(home, ".dsh", "profiles", "headless", "cordis.yml"), "[]\n");
    const patchPath = path.join(home, ".dsh", "profiles", "headless", "cordis.patch.yml");
    const originalPatch = "- id: theme\n  config: { mode: dark }\n";
    await writeFile(patchPath, originalPatch);

    const on = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "glm-fast-latest"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const patched = await readFile(patchPath, "utf8");
    assert.match(patched, /id: llm-pi-ai/);
    assert.match(patched, /fireworks/);
    assert.match(patched, /id: agent-default-model/);
    assert.match(patched, /glm-fast-latest/);
    assert.match(patched, /mode: dark/, "user patch entry preserved");

    const off = await runFireconnect(["deepseek", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(patchPath, "utf8"), originalPatch);
  });

  it("on routes a never-booted dsh through the home patch; off removes it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-home-patch-"));
    const homePatchPath = path.join(home, ".dsh", "cordis.patch.yml");

    const on = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "glm-fast-latest"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    const patched = await readFile(homePatchPath, "utf8");
    assert.match(patched, /id: llm-pi-ai/);
    assert.match(patched, /provider: fireworks/);
    assert.match(patched, /model: glm-fast-latest/);

    // dsh renames settings.yaml away on its first boot; the home patch alone
    // must still report the route.
    await unlink(deepseekSettingsPath(home));
    const status = await runFireconnect(["deepseek", "status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).provider, "fireworks");

    const off = await runFireconnect(["deepseek", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    await assert.rejects(readFile(homePatchPath, "utf8"), { code: "ENOENT" });
  });

  it("on keeps a user's home patch entries and off restores it byte-for-byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-user-home-patch-"));
    const homePatchPath = path.join(home, ".dsh", "cordis.patch.yml");
    const original = "# mine\n- id: theme\n  config: { mode: dark }\n";
    await mkdir(path.dirname(homePatchPath), { recursive: true });
    await writeFile(homePatchPath, original);

    const on = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "glm-fast-latest"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    const patched = await readFile(homePatchPath, "utf8");
    assert.match(patched, /provider: fireworks/);
    assert.match(patched, /mode: dark/, "user patch entry preserved");

    const off = await runFireconnect(["deepseek", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(homePatchPath, "utf8"), original);
  });

  it("off strips the fireworks route from profiles created after on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-late-profile-"));
    const on = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "glm-fast-latest"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    // A profile that only appears after `on` (dsh booted a new profile and
    // imported the managed settings.yaml into it).
    const lateDir = path.join(home, ".dsh", "profiles", "desktop");
    await mkdir(lateDir, { recursive: true });
    await writeFile(path.join(lateDir, "cordis.yml"), "[]\n");
    await writeFile(path.join(lateDir, "cordis.patch.yml"), [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      fireworks:",
      "        apiKeyEnv: FIREWORKS_API_KEY",
      "- id: agent-default-model",
      "  config:",
      "    provider: fireworks",
      "    model: glm-fast-latest",
      "- id: theme",
      "  config: { mode: dark }",
      "",
    ].join("\n"));

    const off = await runFireconnect(["deepseek", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);

    const after = await readFile(path.join(lateDir, "cordis.patch.yml"), "utf8");
    assert.doesNotMatch(after, /fireworks/);
    assert.match(after, /id: theme/, "user patch entry preserved");
  });

  it("a re-on over a dirty patch never snapshots the fireworks route as the original", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-dirty-patch-"));
    const profileDir = path.join(home, ".dsh", "profiles", "headless");
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "cordis.yml"), "[]\n");
    const patchPath = path.join(profileDir, "cordis.patch.yml");

    // First on/off cycle; simulate the backup being lost so the next on sees
    // a patch still carrying the fireworks route.
    const first = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "glm-fast-latest"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);
    await unlink(deepseekBackupPath(deepseekDataDir(home), deepseekSettingsPath(home)));

    const second = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "kimi-fast-latest"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(second.code, 0, second.stderr);

    const off = await runFireconnect(["deepseek", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    assert.doesNotMatch(await readFile(patchPath, "utf8"), /fireworks/);
  });

  it("status falls back to the profile patch after dsh migrates settings.yaml away", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-migrated-"));
    const on = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "deepseek-v4-flash"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    // Simulate dsh 0.1.7's legacy import: settings.yaml is renamed away and the
    // sections land in the profile patch instead.
    await mkdir(path.join(home, ".dsh", "profiles", "headless"), { recursive: true });
    await writeFile(path.join(home, ".dsh", "profiles", "headless", "cordis.yml"), "[]\n");
    const settingsRaw = await readFile(deepseekSettingsPath(home), "utf8");
    await writeFile(path.join(home, ".dsh", "settings.yaml.imported"), settingsRaw);
    await unlink(deepseekSettingsPath(home));
    await writeFile(path.join(home, ".dsh", "profiles", "headless", "cordis.patch.yml"), [
      "- id: llm-pi-ai",
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      "  config:",
      "    providers:",
      "      fireworks:",
      "        apiKeyEnv: FIREWORKS_API_KEY",
      "        api: openai-completions",
      "        baseURL: https://api.fireworks.ai/inference/v1",
      "- id: agent-default-model",
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      "  config:",
      "    provider: fireworks",
      "    model: deepseek-v4-flash",
      "",
    ].join("\n"));

    const status = await runFireconnect(["deepseek", "status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(status.code, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.provider, "fireworks");
    assert.equal(payload.current.main, "deepseek-v4-flash");
    assert.equal(payload.hasAuthToken, true);
  });
});

describe("migrateDeepseekFirerouterModel", () => {
  it("moves settings and every patch layer to auto, leaving credentials and backups untouched", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-firerouter-migrate-"));
    const settingsPath = deepseekSettingsPath(home);
    const credentialsPath = deepseekCredentialsPath(home);
    const dataDir = deepseekDataDir(home);
    await mkdir(path.join(home, ".dsh", "profiles", "p1"), { recursive: true });
    await writeFile(path.join(home, ".dsh", "profiles", "p1", "cordis.yml"), "{}\n");

    // Seed the layers an earlier release wrote for `--model firerouter`.
    await enableDeepseekFireworks({
      settingsPath,
      credentialsPath,
      dataDir,
      effectiveApiKey: "fw_test_key_12345",
      modelId: "firerouter",
      headers: { "X-Title": "DeepSeek Harness" },
    });
    assert.equal(deepseekCurrentModelId((await readDeepseekSettingsIfExists(settingsPath)).settings), "firerouter");
    const credentialsBefore = await readFile(credentialsPath, "utf8");
    const backupPath = deepseekBackupPath(dataDir, settingsPath);
    const backupBefore = await readFile(backupPath, "utf8");
    const patchPaths = [
      path.join(home, ".dsh", "cordis.patch.yml"),
      path.join(home, ".dsh", "profiles", "p1", "cordis.patch.yml"),
    ];
    for (const patchPath of patchPaths) {
      assert.match(await readFile(patchPath, "utf8"), /firerouter/, patchPath);
    }

    assert.equal(await migrateDeepseekFirerouterModel({ settingsPath }), true);

    assert.equal(deepseekCurrentModelId((await readDeepseekSettingsIfExists(settingsPath)).settings), "auto");
    for (const patchPath of patchPaths) {
      const raw = await readFile(patchPath, "utf8");
      assert.doesNotMatch(raw, /firerouter/, patchPath);
      assert.match(raw, /auto/, patchPath);
      assert.match(raw, /X-Title/, "headers preserved");
    }
    assert.equal(await readFile(credentialsPath, "utf8"), credentialsBefore);
    assert.equal(await readFile(backupPath, "utf8"), backupBefore, "off snapshot untouched");

    assert.equal(await migrateDeepseekFirerouterModel({ settingsPath }), false, "second run no-ops");
  });

  it("migrates retired patch layers even when the settings layer is current", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-firerouter-mixed-"));
    const settingsPath = deepseekSettingsPath(home);
    await mkdir(path.join(home, ".dsh", "profiles", "p1"), { recursive: true });
    await writeFile(path.join(home, ".dsh", "profiles", "p1", "cordis.yml"), "{}\n");
    await enableDeepseekFireworks({
      settingsPath,
      credentialsPath: deepseekCredentialsPath(home),
      dataDir: deepseekDataDir(home),
      effectiveApiKey: "fw_test_key_12345",
      modelId: "firerouter",
    });
    // The winning (settings) layer moves on; the patch layers stay retired.
    const { settings } = await readDeepseekSettingsIfExists(settingsPath);
    await writeFile(settingsPath, JSON.stringify(patchDeepseekFireworksSettings(settings, {
      modelId: "deepseek-v4-flash",
      headers: {},
    })));

    assert.equal(await migrateDeepseekFirerouterModel({ settingsPath }), true);
    const patchPath = path.join(home, ".dsh", "cordis.patch.yml");
    assert.doesNotMatch(await readFile(patchPath, "utf8"), /firerouter/);
    assert.equal(
      deepseekCurrentModelId((await readDeepseekSettingsIfExists(settingsPath)).settings),
      "deepseek-v4-flash",
      "current settings layer untouched",
    );
  });

  it("no-ops when DeepSeek is not on a FireRouter selection", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-firerouter-migrate-noop-"));
    const settingsPath = deepseekSettingsPath(home);
    assert.equal(await migrateDeepseekFirerouterModel({ settingsPath }), false);
  });
});
