import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { globalConfigPath, readGlobalConfig, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piAuthPath, piModelsPath } from "../../lib/harnesses/pi/core.mjs";
import { removeLegacyShellHooks } from "../../lib/io/shell-env-hook.mjs";
import {
  migrateEnvProviderKeyRefsOnUpgrade,
  migrateLegacyRouterAnthropicProviderOnUpgrade,
} from "../../lib/system/env-key-migrations.mjs";
import { runHarnessForwardMigrations } from "../../lib/system/forward-migrations.mjs";
import { withTempHome } from "../helpers.mjs";

async function writeJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("upgrade cleanup of environment provider keys from earlier FireConnect", () => {
  it("clears {env:...} key references from config.json, keeps literal keys, then no-ops", async () => {
    await withTempHome("env-key-refs-", async (home) => {
      await writeGlobalConfig(home, {
        anthropicApiKey: "{env:ANTHROPIC_API_KEY}",
        openaiApiKey: "sk-proj-example-0000",
      });
      assert.equal(await migrateEnvProviderKeyRefsOnUpgrade(home), true);
      const config = await readGlobalConfig(home);
      assert.equal(config.anthropicApiKey ?? "", "");
      assert.equal(config.openaiApiKey, "sk-proj-example-0000");
      assert.equal(await migrateEnvProviderKeyRefsOnUpgrade(home), false);
    });
  });

  it("removes the fireconnect shell block that exported ANTHROPIC_API_KEY and OPENAI_API_KEY from every shell file", async () => {
    await withTempHome("env-key-shell-", async (home) => {
      const block = [
        "# >>> fireconnect >>>",
        'export ANTHROPIC_API_KEY="$(fireconnect key export --stored-only --anthropic 2>/dev/null)"',
        'export OPENAI_API_KEY="$(fireconnect key export --stored-only --openai 2>/dev/null)"',
        "# <<< fireconnect <<<",
      ];
      for (const name of [".zshrc", ".bashrc", ".bash_profile"]) {
        await writeFile(path.join(home, name), ["# mine", 'export OPENAI_API_KEY="sk-user-own"', ...block, ""].join("\n"));
      }
      assert.equal(await removeLegacyShellHooks(home), true);
      for (const name of [".zshrc", ".bashrc", ".bash_profile"]) {
        const raw = await readFile(path.join(home, name), "utf8");
        assert.doesNotMatch(raw, /fireconnect/, name);
        assert.doesNotMatch(raw, /ANTHROPIC_API_KEY/, name);
        // A key the user exported themselves stays.
        assert.match(raw, /export OPENAI_API_KEY="sk-user-own"/, name);
      }
    });
  });

  it("removes the pre-0.9 OpenCode router retarget of provider.anthropic, keeping the user's own settings", async () => {
    await withTempHome("env-key-opencode-", async (home) => {
      const configPath = opencodeConfigPath(home, "");
      await writeJsonFile(configPath, {
        provider: {
          anthropic: {
            name: "Anthropic (FireRouter)",
            options: {
              apiKey: "{env:ANTHROPIC_API_KEY}",
              baseURL: "https://router.fireworks.ai/v1",
              headers: { "X-Fireworks-Api-Key": "fw_example_0000", "X-Custom": "keep" },
              timeout: 600000,
            },
          },
        },
        model: "anthropic/claude-opus-4-8",
      });
      assert.equal(await migrateLegacyRouterAnthropicProviderOnUpgrade(home), true);
      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(config.provider.anthropic, { options: { headers: { "X-Custom": "keep" }, timeout: 600000 } });
      assert.equal(config.model, "anthropic/claude-opus-4-8");
      assert.equal(await migrateLegacyRouterAnthropicProviderOnUpgrade(home), false);
    });
  });

  it("leaves a user's own OpenCode Anthropic provider alone", async () => {
    await withTempHome("env-key-opencode-own-", async (home) => {
      const configPath = opencodeConfigPath(home, "");
      const own = { provider: { anthropic: { options: { apiKey: "{env:ANTHROPIC_API_KEY}" } } } };
      await writeJsonFile(configPath, own);
      assert.equal(await migrateLegacyRouterAnthropicProviderOnUpgrade(home), false);
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), own);
    });
  });

  it("removes the pre-0.9 Pi router retarget and its $ANTHROPIC_API_KEY auth entry", async () => {
    await withTempHome("env-key-pi-", async (home) => {
      await writeJsonFile(piModelsPath(home), {
        providers: {
          anthropic: {
            name: "Anthropic (FireRouter)",
            baseUrl: "https://router.fireworks.ai",
            headers: { "X-Fireworks-Api-Key": "fw_example_0000" },
          },
          fireworks: { models: [] },
        },
      });
      await writeJsonFile(piAuthPath(home), {
        anthropic: { type: "api_key", key: "$ANTHROPIC_API_KEY" },
        fireworks: { type: "api_key", key: "fw_example_0000" },
      });
      assert.equal(await migrateLegacyRouterAnthropicProviderOnUpgrade(home), true);
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers.anthropic, undefined);
      assert.deepEqual(models.providers.fireworks, { models: [] });
      const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
      assert.equal(auth.anthropic, undefined);
      assert.equal(auth.fireworks.key, "fw_example_0000");
    });
  });

  it("runs as part of the upgrade migrations", async () => {
    await withTempHome("env-key-upgrade-", async (home) => {
      await writeGlobalConfig(home, { anthropicApiKey: "{env:ANTHROPIC_API_KEY}" });
      const notes = await runHarnessForwardMigrations(home);
      assert.ok(notes.some((note) => /no longer reads ANTHROPIC_API_KEY or OPENAI_API_KEY from your environment/.test(note)), notes.join("\n"));
      assert.doesNotMatch(await readFile(globalConfigPath(home), "utf8"), /\{env:ANTHROPIC_API_KEY\}/);
    });
  });
});
