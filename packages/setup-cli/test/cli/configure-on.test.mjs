import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIREWORKS_API_KEY_ENV_REF, globalConfigPath, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { piAuthPath } from "../../lib/harnesses/pi/core.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { MISSING_FIREWORKS_API_KEY_MESSAGE } from "../../lib/keys/key-type.mjs";
import { runFireconnect, seedKeychainConfig } from "../helpers.mjs";

describe("configure to harness on propagation", () => {
  it("gives every direct harness the same login and custom SSO guidance when no key exists", async () => {
    for (const harness of ["claude", "opencode", "codex", "pi", "cursor", "vscode", "deepseek"]) {
      const home = await mkdtemp(path.join(os.tmpdir(), `fc-missing-${harness}-`));
      const result = await runFireconnect(
        [harness, "on"],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.notEqual(result.code, 0, `${harness} unexpectedly succeeded`);
      assert.match(result.stderr, /No Fireworks API key found\. No settings were changed\./);
      assert.match(result.stderr, /nexus login/);
      assert.match(result.stderr, /nexus login --account <account-id>/);
    }
  });

  it("pi on reads keychain key from configure global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-pi-on-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");

    const onResult = await runFireconnect(["pi", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0);

    const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
    assert.equal(auth.fireworks.key, "fw_test_key_12345");
  });

  it("pi on fails with guidance when no key is available", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-pi-missing-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });

    const onResult = await runFireconnect(["pi", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.notEqual(onResult.code, 0);
    assert.match(onResult.stderr, new RegExp(MISSING_FIREWORKS_API_KEY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("pi on accepts legacy global env ref when FIREWORKS_API_KEY is set", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-pi-legacy-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_ENV_REF,
      harnesses: { pi: { enabled: false } },
    });

    const onResult = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
    assert.equal(auth.fireworks.key, "fw_test_key_12345");
  });

  it("opencode on reads keychain key from configure global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-oc-on-"));
    await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");

    const onResult = await runFireconnect(["opencode", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0, onResult.stderr);

    const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
    assert.equal(
      config.provider["fireworks-ai"].options.apiKey,
      "fw_test_key_12345",
    );
  });

  it("codex on reads keychain key from configure global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-codex-on-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");

    const onResult = await runFireconnect(["codex", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0);

    const config = await readFile(codexConfigPath(home), "utf8");
    assert.match(config, /"x-fireworks-api-key" = "fw_test_key_12345"/);
    assert.doesNotMatch(config, /env_key = "FIREWORKS_API_KEY"/);
  });

  it("deepseek on reads keychain key from configure global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-deepseek-on-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");

    const onResult = await runFireconnect(["deepseek", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0);

    const settings = await readFile(path.join(home, ".dsh/settings.yaml"), "utf8");
    assert.match(settings, /apiKeyEnv: FIREWORKS_API_KEY/);
    assert.match(settings, /baseURL: https:\/\/api\.fireworks\.ai\/inference\/v1/);
    const credentials = await readFile(path.join(home, ".dsh/.credentials.yaml"), "utf8");
    assert.match(credentials, /FIREWORKS_API_KEY: fw_test_key_12345/);
  });

  it("deepseek on fails with guidance when configure stored no key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-deepseek-missing-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });

    const onResult = await runFireconnect(["deepseek", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.notEqual(onResult.code, 0);
    assert.match(onResult.stderr, new RegExp(MISSING_FIREWORKS_API_KEY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("a key saved with nexus auto reaches the harness on its next on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-auto-key-opencode-"));
    await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" };

    const saved = await runFireconnect(["auto", "--anthropic-api-key", "sk-ant-global-key-12345"], env);
    assert.equal(saved.code, 0, saved.stderr);
    const onResult = await runFireconnect(["opencode", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(onResult.code, 0, onResult.stderr);

    const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
    assert.equal(
      config.provider["fireworks-ai"].options.headers["x-anthropic-api-key"],
      "sk-ant-global-key-12345",
    );
  });

  it("on leaves an exported ANTHROPIC_API_KEY out of the harness config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-on-env-anthropic-"));
    await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });

    const onResult = await runFireconnect(
      ["opencode", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "sk-ant-env-only-12345" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const raw = await readFile(opencodeConfigPath(home), "utf8");
    assert.doesNotMatch(raw, /sk-ant-env-only-12345/);
  });

  it("on refuses provider-key flags and points to nexus auto, persisting nothing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-on-refuse-anthropic-"));
    await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });

    const onResult = await runFireconnect(
      [
        "opencode", "on",
        "--api-key", "fw_test_key_12345",
        "--anthropic-api-key", "sk-ant-global-key-12345",
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.notEqual(onResult.code, 0);
    assert.match(onResult.stderr, /Save the key once with `nexus auto --anthropic-api-key <key>`/);

    const globalConfig = JSON.parse(await readFile(globalConfigPath(home), "utf8").catch(() => "{}"));
    assert.ok(!globalConfig.anthropicApiKey, JSON.stringify(globalConfig));
  });

  it("nexus auto rejects an invalid --anthropic-api-key without persisting it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-auto-invalid-anthropic-"));
    const result = await runFireconnect(
      ["auto", "--anthropic-api-key", "fw_not_anthropic"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--anthropic-api-key must be an Anthropic API key/);

    const globalConfig = JSON.parse(await readFile(globalConfigPath(home), "utf8").catch(() => "{}"));
    assert.ok(!globalConfig.anthropicApiKey, JSON.stringify(globalConfig));
  });

  it("on without --api-key does not overwrite global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-on-no-global-"));
    await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });
    await writeGlobalConfig(home, {
      apiKey: "fw_existing_global_key_12345",
      harnesses: { opencode: { enabled: false } },
    });

    const onResult = await runFireconnect(
      ["opencode", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_env_only_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const globalConfig = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(globalConfig.apiKey, "{keychain:fireworks-api-key}");
  });

  it("opencode on writes a literal apiKey when only FIREWORKS_API_KEY is set", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-oc-env-"));
    await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });

    const onResult = await runFireconnect(
      ["opencode", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
    assert.equal(
      config.provider["fireworks-ai"].options.apiKey,
      "fw_test_key_12345",
    );
  });
});
