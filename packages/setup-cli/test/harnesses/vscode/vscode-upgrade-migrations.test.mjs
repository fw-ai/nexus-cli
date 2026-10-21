import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  addFireworksProvider,
  buildModelEntry,
  FIRECONNECT_PROVIDER_NAME,
  makeFireconnectSecretId,
} from "../../../lib/harnesses/vscode/core.mjs";
import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import {
  migrateVscodeFirerouterOnUpgrade,
  migrateVscodeResponsesApiType,
} from "../../../lib/harnesses/vscode/upgrade-migrations.mjs";
import { withTempHome } from "../../helpers.mjs";

/** A non-fireconnect provider (user-managed) to prove ownership scoping. */
function userProvider(name = "MyOther") {
  return {
    name,
    vendor: "customendpoint",
    apiType: "chat-completions",
    apiKey: "${input:chat.lm.secret.user-managed-id}",
    models: [{ id: "other-model", name: "Other", url: "https://other.example", toolCalling: false, vision: false, maxInputTokens: 8000, maxOutputTokens: 2000 }],
  };
}

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

describe("migrateVscodeResponsesApiType", () => {
  const legacyProvider = (secretId) => ({
    name: FIRECONNECT_PROVIDER_NAME,
    vendor: "customendpoint",
    apiType: "responses",
    apiKey: `\${input:${secretId}}`,
    models: [buildModelEntry("accounts/fireworks/routers/glm-latest")],
  });

  it("flips the fireconnect provider to chat-completions, leaving user providers alone", async () => {
    await withTempHome("vscode-migrate-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const secretId = makeFireconnectSecretId();
      await writeFile(vscodePath, `${JSON.stringify([userProvider(), legacyProvider(secretId)])}\n`);

      const migrated = await migrateVscodeResponsesApiType(home, { vscodePath, isRunning: () => false });
      assert.equal(migrated, true);

      const arr = await readJson(vscodePath);
      assert.deepEqual(arr[0], userProvider());
      assert.equal(arr[1].apiType, "chat-completions");
      assert.equal(arr[1].apiKey, `\${input:${secretId}}`);
      assert.equal(arr[1].models[0].id, "glm-latest");
    });
  });

  it("no-ops when the provider is already chat-completions or absent", async () => {
    await withTempHome("vscode-migrate-noop-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const secretId = makeFireconnectSecretId();
      const original = `${JSON.stringify(
        addFireworksProvider([], { secretId, models: [buildModelEntry("accounts/fireworks/routers/glm-latest")] }),
      )}\n`;
      await writeFile(vscodePath, original);

      assert.equal(await migrateVscodeResponsesApiType(home, { vscodePath, isRunning: () => false }), false);
      assert.equal(await readFile(vscodePath, "utf8"), original);

      await writeFile(vscodePath, `${JSON.stringify([userProvider()])}\n`);
      assert.equal(await migrateVscodeResponsesApiType(home, { vscodePath, isRunning: () => false }), false);
    });
  });

  it("skips while VS Code is running", async () => {
    await withTempHome("vscode-migrate-running-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const original = `${JSON.stringify([legacyProvider(makeFireconnectSecretId())])}\n`;
      await writeFile(vscodePath, original);

      assert.equal(await migrateVscodeResponsesApiType(home, { vscodePath, isRunning: () => true }), false);
      assert.equal(await readFile(vscodePath, "utf8"), original);
    });
  });
});

describe("migrateVscodeFirerouterOnUpgrade", () => {
  const providerWith = (models) => ({
    name: FIRECONNECT_PROVIDER_NAME,
    vendor: "customendpoint",
    apiType: "chat-completions",
    apiKey: `\${input:${makeFireconnectSecretId()}}`,
    models,
  });

  async function seed(home, vscodePath, models, { enabled = true } = {}) {
    await writeGlobalConfig(home, {
      harnesses: { vscode: { enabled, provider: "fireworks" } },
    });
    await writeFile(vscodePath, `${JSON.stringify([userProvider(), providerWith(models)])}\n`);
  }

  it("drops FireRouter rows and keeps everything else, then no-ops", async () => {
    await withTempHome("vscode-firerouter-migrate-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await seed(home, vscodePath, [
        buildModelEntry("firerouter"),
        buildModelEntry("accounts/fireworks/routers/glm-latest"),
        buildModelEntry("firerouter/opus"),
      ]);

      assert.equal(await migrateVscodeFirerouterOnUpgrade(home, { vscodePath, isRunning: () => false }), true);
      const arr = await readJson(vscodePath);
      assert.deepEqual(arr[0], userProvider());
      assert.deepEqual(arr[1].models.map((m) => m.id), ["glm-latest"]);

      assert.equal(await migrateVscodeFirerouterOnUpgrade(home, { vscodePath, isRunning: () => false }), false);
    });
  });

  it("skips while running and when the harness is off", async () => {
    await withTempHome("vscode-firerouter-migrate-off-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await seed(home, vscodePath, [buildModelEntry("firerouter")]);
      const original = await readFile(vscodePath, "utf8");
      assert.equal(await migrateVscodeFirerouterOnUpgrade(home, { vscodePath, isRunning: () => true }), false);
      assert.equal(await readFile(vscodePath, "utf8"), original);

      await seed(home, vscodePath, [buildModelEntry("firerouter")], { enabled: false });
      assert.equal(await migrateVscodeFirerouterOnUpgrade(home, { vscodePath, isRunning: () => false }), false);
    });
  });
});
