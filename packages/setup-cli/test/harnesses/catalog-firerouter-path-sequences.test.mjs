import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { codexCatalogPath, codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { OPENCODE_FIREWORKS_PROVIDER_ID, opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piModelsPath, piSettingsPath } from "../../lib/harnesses/pi/core.mjs";
import { USER_SETTINGS_RELATIVE_PATH } from "../../lib/harnesses/claude/core.mjs";
import { isFireconnectProvider } from "../../lib/harnesses/vscode/core.mjs";
import { runFireconnect, withTempHome } from "../helpers.mjs";

const API_KEY = "fw_cataloged_v1_adversarial000000";
const FIREROUTER_TEST_PATH = "firerouter/test-model";
const NO_ENV = { FIREWORKS_API_KEY: "" };

/** Run an `on` step that must succeed. */
async function onOk(home, args) {
  const result = await runFireconnect(args, { HOME: home, ...NO_ENV });
  assert.equal(result.code, 0, result.stderr);
  return result;
}

/** Assert an explicit FireRouter selection is rejected and writes nothing new. */
async function onRejected(home, args) {
  const result = await runFireconnect(args, { HOME: home, ...NO_ENV });
  assert.notEqual(result.code, 0, args.join(" "));
  assert.match(result.stderr, /is no longer supported/, args.join(" "));
  return result;
}

describe("FireRouter path catalog sequences across harnesses", () => {
  it("codex: rejects a FireRouter path; a stored one drops to auto on plain re-on", async () => {
    await withTempHome("seq-codex-bare-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await onOk(home, ["codex", "on", "--api-key", API_KEY]);
      await onRejected(home, ["codex", "on", "--api-key", API_KEY, "--model", FIREROUTER_TEST_PATH]);
      let config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /^model = "auto"$/m, "rejection left the plain-on config alone");

      // What an earlier release wrote for `--model firerouter/test-model`.
      await writeFile(
        codexConfigPath(home),
        (await readFile(codexConfigPath(home), "utf8"))
          .replace(/^model = .*$/m, `model = "${FIREROUTER_TEST_PATH}"`),
      );
      const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
      catalog.models.push({ slug: FIREROUTER_TEST_PATH, display_name: "FireRouter · Test" });
      await writeFile(codexCatalogPath(home), JSON.stringify(catalog));

      await onOk(home, ["codex", "on", "--api-key", API_KEY]);
      config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /^model = "auto"$/m);
      const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8"))
        .models
        .map((row) => row.slug);
      assert.ok(!slugs.some((slug) => slug.startsWith("firerouter")), "stored compound row dropped on plain re-on");

      await onRejected(home, ["codex", "on", "--api-key", API_KEY, "--model", "firerouter"]);
      config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /^model = "auto"$/m);
    });
  });

  it("opencode: rejects a FireRouter path; a stored one drops to auto on plain re-on", async () => {
    await withTempHome("seq-opencode-", async (home) => {
      await mkdir(path.join(home, ".config/opencode"), { recursive: true });
      await onOk(home, ["opencode", "on", "--api-key", API_KEY]);
      await onRejected(home, ["opencode", "on", "--api-key", API_KEY, "--model", FIREROUTER_TEST_PATH]);

      // What an earlier release wrote for `--model firerouter/test-model`.
      const seeded = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
      seeded.model = `fireworks-ai/${FIREROUTER_TEST_PATH}`;
      seeded.provider[OPENCODE_FIREWORKS_PROVIDER_ID].models[FIREROUTER_TEST_PATH] = { name: "FireRouter" };
      await writeFile(opencodeConfigPath(home), JSON.stringify(seeded));

      await onOk(home, ["opencode", "on", "--api-key", API_KEY]);
      const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
      assert.equal(config.model, "fireworks-ai/auto");
      const models = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.models ?? {};
      assert.ok(!models[FIREROUTER_TEST_PATH], "firerouter override dropped on plain re-on");
      assert.ok(models["kimi-latest"]);
    });
  });

  it("pi: rejects a FireRouter path; a stored one drops to auto on plain re-on", async () => {
    await withTempHome("seq-pi-", async (home) => {
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await onOk(home, ["pi", "on", "--api-key", API_KEY]);
      await onRejected(home, ["pi", "on", "--api-key", API_KEY, "--model", FIREROUTER_TEST_PATH]);

      // What an earlier release wrote for `--model firerouter/test-model`.
      const settingsPath = piSettingsPath(home);
      const seeded = JSON.parse(await readFile(settingsPath, "utf8"));
      seeded.defaultModel = FIREROUTER_TEST_PATH;
      await writeFile(settingsPath, JSON.stringify(seeded));
      const modelsPath = piModelsPath(home);
      const seededModels = JSON.parse(await readFile(modelsPath, "utf8"));
      seededModels.providers.fireworks.models.push({ id: FIREROUTER_TEST_PATH });
      await writeFile(modelsPath, JSON.stringify(seededModels));

      await onOk(home, ["pi", "on", "--api-key", API_KEY]);
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.defaultModel, "auto");

      const ids = JSON.parse(await readFile(modelsPath, "utf8"))
        .providers
        .fireworks
        .models
        .map((row) => row.id);
      assert.ok(!ids.includes(FIREROUTER_TEST_PATH), "firerouter entry dropped on plain re-on");
    });
  });

  it("claude: rejects a FireRouter path without pinning anything", async () => {
    await withTempHome("seq-claude-", async (home) => {
      await onOk(home, ["claude", "on", "--api-key", API_KEY]);
      const before = await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8");
      await onRejected(home, ["claude", "on", "--api-key", API_KEY, "--model", FIREROUTER_TEST_PATH]);
      assert.equal(await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8"), before);

      const settings = JSON.parse(before);
      assert.equal(settings.model, "auto[1m]");
      assert.equal(settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
      assert.equal(settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
      const pickerModels = settings.modelPicker?.options?.map((row) => row.model) ?? [];
      assert.ok(!pickerModels.some((model) => model.startsWith("firerouter")), pickerModels.join(", "));
    });
  });

  it("vscode: rejects a FireRouter path; a stored row drops on plain re-on", async () => {
    await withTempHome("seq-vscode-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await writeFile(vscodePath, "[]\n");

      await onOk(home, ["vscode", "on", "--api-key", API_KEY, "--vscode-path", vscodePath, "--force"]);
      await onRejected(home, ["vscode", "on", "--api-key", API_KEY, "--model", FIREROUTER_TEST_PATH, "--vscode-path", vscodePath, "--force"]);

      // What an earlier release registered for `--model firerouter/test-model`.
      const seeded = JSON.parse(await readFile(vscodePath, "utf8"));
      const seededProvider = seeded.find(isFireconnectProvider);
      seededProvider.models.push({ id: FIREROUTER_TEST_PATH, vision: true });
      await writeFile(vscodePath, JSON.stringify(seeded));

      await onOk(home, ["vscode", "on", "--api-key", API_KEY, "--vscode-path", vscodePath, "--force"]);
      const provider = JSON.parse(await readFile(vscodePath, "utf8")).find(isFireconnectProvider);
      assert.ok(provider, "fireconnect provider registered");
      const ids = provider.models.map((row) => row.id);
      assert.ok(!ids.includes(FIREROUTER_TEST_PATH), "firerouter row dropped on plain re-on");
      assert.ok(ids.includes("kimi-latest"));
    });
  });

});
