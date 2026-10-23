import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { migrateClaudeBakedAnthropicKeyOnUpgrade } from "../../lib/harnesses/claude/upgrade-migrations.mjs";
import { reapplySavedProviderKeysOnUpgrade } from "../../lib/system/provider-keys-upgrade.mjs";
import { withTempHome } from "../helpers.mjs";

const ANT = "sk-ant-example-upgrade-0000";
const OAI = "sk-proj-example-upgrade-0000";

async function writeJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function recorder() {
  const ran = [];
  return { ran, run: async (route) => { ran.push(`${route.harnessId} ${route.verb}`); } };
}

describe("reapplySavedProviderKeysOnUpgrade", () => {
  it("re-runs on for connected harnesses missing a saved key, skipping those that already carry it", async () => {
    await withTempHome("upgrade-keys-reapply-", async (home) => {
      await writeGlobalConfig(home, {
        anthropicApiKey: ANT,
        openaiApiKey: OAI,
        harnesses: {
          opencode: { enabled: true, provider: "fireworks" },
          claude: { enabled: true, provider: "fireworks" },
          cursor: { enabled: true, provider: "fireworks" },
        },
      });
      await writeJsonFile(opencodeConfigPath(home, ""), {
        provider: { "fireworks-ai": { options: { apiKey: "fw_x", headers: {} }, models: {} } },
        model: "fireworks-ai/auto",
      });
      // Claude Code already carries the saved OpenAI key; it never gets the Anthropic one.
      await writeJsonFile(userSettingsPath(home), {
        env: { ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: fw_x\nx-openai-api-key: ${OAI}` },
      });
      const { ran, run } = recorder();
      const notes = await reapplySavedProviderKeysOnUpgrade(home, { run });
      assert.deepEqual(ran, ["opencode on"]);
      assert.deepEqual(notes, ["Added the keys you saved for Nexus Auto to OpenCode. Restart it to pick them up."]);
    });
  });

  it("moves Claude Code off the retired router host even with no saved keys", async () => {
    await withTempHome("upgrade-keys-router-", async (home) => {
      await writeGlobalConfig(home, { harnesses: { claude: { enabled: true } } });
      await writeJsonFile(userSettingsPath(home), { env: { ANTHROPIC_BASE_URL: "https://router.fireworks.ai" } });
      const { ran, run } = recorder();
      const notes = await reapplySavedProviderKeysOnUpgrade(home, { run });
      assert.deepEqual(ran, ["claude on"]);
      assert.match(notes[0], /Moved Claude Code off the retired FireRouter host/);
    });
  });

  it("leaves an open VS Code alone, and does nothing without saved keys or legacy setups", async () => {
    await withTempHome("upgrade-keys-vscode-", async (home) => {
      await writeGlobalConfig(home, { anthropicApiKey: ANT, harnesses: { vscode: { enabled: true, provider: "fireworks" } } });
      const { ran, run } = recorder();
      const notes = await reapplySavedProviderKeysOnUpgrade(home, { run, vscodeRunning: () => true });
      assert.deepEqual(ran, []);
      assert.match(notes[0], /Quit VS Code, then run nexus vscode/);
    });
    await withTempHome("upgrade-keys-fireworks-scope-", async (home) => {
      await writeGlobalConfig(home, {
        anthropicApiKey: ANT,
        auto: { providers: ["fireworks"] },
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      await writeJsonFile(opencodeConfigPath(home, ""), {
        provider: { "fireworks-ai": { options: { apiKey: "fw_x", headers: {} }, models: {} } },
        model: "fireworks-ai/auto",
      });
      const { ran, run } = recorder();
      assert.deepEqual(await reapplySavedProviderKeysOnUpgrade(home, { run }), []);
      assert.deepEqual(ran, []);
    });
    await withTempHome("upgrade-keys-none-", async (home) => {
      await writeGlobalConfig(home, { harnesses: { opencode: { enabled: true, provider: "fireworks" } } });
      const { ran, run } = recorder();
      assert.deepEqual(await reapplySavedProviderKeysOnUpgrade(home, { run }), []);
      assert.deepEqual(ran, []);
    });
  });
});

describe("migrateClaudeBakedAnthropicKeyOnUpgrade", () => {
  it("removes an Anthropic key Nexus copied in, keeps one that was there before Nexus", async () => {
    await withTempHome("upgrade-claude-baked-", async (home) => {
      await writeGlobalConfig(home, { harnesses: { claude: { enabled: true, provider: "fireworks" } } });
      const settings = {
        env: {
          ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_x",
          ANTHROPIC_API_KEY: ANT,
          ANTHROPIC_AUTH_TOKEN: "sk-ant-users-own-0000",
        },
      };
      await writeJsonFile(userSettingsPath(home), settings);
      await writeJsonFile(path.join(home, ".nexus/claude/provider-backup.json"), {
        snapshot: { existed: true, raw: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-users-own-0000" } }) },
      });
      assert.equal(await migrateClaudeBakedAnthropicKeyOnUpgrade(home), true);
      const env = JSON.parse(await readFile(userSettingsPath(home), "utf8")).env;
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-ant-users-own-0000");
      assert.equal(await migrateClaudeBakedAnthropicKeyOnUpgrade(home), false);
    });
  });
});
