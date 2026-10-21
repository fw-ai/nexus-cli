import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import {
  USER_SETTINGS_RELATIVE_PATH,
} from "../../../lib/harnesses/claude/core.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { cacheServerlessCatalogSnapshot, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  FIRECONNECT_REFERER,
  mockServerlessModel,
  runFireconnect,
  withTempHome,
  assertClaudeMainModel,
  assertClaudeNativeTierSlots,
  assertClaudeRegisterablePicker,
} from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_claude_matrix_key_000000000000";

/** Persist the alias catalog a spawned CLI child resolves default slots through. */
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
        name: "accounts/fireworks/models/glm-5p3-flash",
        displayName: "GLM 5.3 Flash",
        input_modalities: ["text", "image"],
        aliases: ["accounts/fireworks/routers/glm-flash-latest"],
      }),
    ]));
  } finally {
    process.env.HOME = prevHome;
    setServerlessCatalogSnapshot(null);
  }
}
const ANTHROPIC_KEY = "sk-ant-claude-matrix-byok";
const KIMI_FABLE_MODEL = "glm-flash-latest[1m]";
const GLM_SONNET_MODEL = "glm-latest[1m]";
const FIREROUTER_MODEL = "firerouter[1m]";
const SUBSCRIPTION_SETTINGS = `${JSON.stringify({
  model: "sonnet",
  theme: "dark",
}, null, 2)}\n`;
const SUBSCRIPTION_CREDENTIALS = `${JSON.stringify({
  claudeAiOauth: {
    accessToken: "oauth-test-token",
    refreshToken: "oauth-test-refresh",
  },
}, null, 2)}\n`;

async function pathExists(filePath) {
  return access(filePath).then(() => true).catch(() => false);
}

const scenarios = [];
for (const subscription of [true, false]) {
  for (const byok of [true, false]) {
    for (const firerouter of [true, false]) {
      scenarios.push({ subscription, byok, firerouter });
    }
  }
}

describe("Claude subscription, BYOK, and FireRouter matrix", () => {
  for (const scenario of scenarios) {
    const subscriptionLabel = scenario.subscription ? "subscription" : "no subscription";
    const byokLabel = scenario.byok ? "BYOK" : "no BYOK";
    const modeLabel = scenario.firerouter ? "explicit --model firerouter (rejected)" : "fresh defaults";

    it(`${subscriptionLabel}, ${byokLabel}, ${modeLabel}`, async () => {
      await withTempHome("claude-auth-matrix-", async (home) => {
        seedCatalogFor(home);
        const claudeDir = path.join(home, ".claude");
        const settingsPath = path.join(home, USER_SETTINGS_RELATIVE_PATH);
        const credentialsPath = path.join(claudeDir, ".credentials.json");
        await mkdir(claudeDir, { recursive: true });

        if (scenario.subscription) {
          await writeFile(settingsPath, SUBSCRIPTION_SETTINGS);
          await writeFile(credentialsPath, SUBSCRIPTION_CREDENTIALS);
        }
        if (scenario.byok) {
          await writeGlobalConfig(home, { anthropicApiKey: ANTHROPIC_KEY });
        }

        const args = [
          "claude",
          "on",
          "--api-key",
          FIREWORKS_KEY,
          ...(scenario.firerouter ? ["--model", "firerouter"] : []),
        ];
        const env = {
          HOME: home,
          FIREWORKS_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
        };
        const enabled = await runFireconnect(args, env);
        if (scenario.firerouter) {
          // A FireRouter selection is rejected in every auth combination,
          // before any settings are written.
          assert.notEqual(enabled.code, 0, enabled.stderr);
          assert.match(enabled.stderr, /is a FireRouter route, which is no longer supported/);
          if (scenario.subscription) {
            assert.equal(await readFile(settingsPath, "utf8"), SUBSCRIPTION_SETTINGS);
            assert.equal(await readFile(credentialsPath, "utf8"), SUBSCRIPTION_CREDENTIALS);
          } else {
            assert.equal(await pathExists(settingsPath), false);
          }
          return;
        }
        assert.equal(enabled.code, 0, enabled.stderr);

        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        const headers = settings.env.ANTHROPIC_CUSTOM_HEADERS;
        assert.equal(settings.env.ANTHROPIC_BASE_URL, FIREWORKS_BASE_URL);
        // A saved Anthropic key is for other harnesses; Claude Code signs in on its own.
        assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
        assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
        assertClaudeMainModel(settings, "auto[1m]");
        {
          assertClaudeNativeTierSlots(settings);
          assertClaudeRegisterablePicker(settings, {
            includes: ["auto[1m]", "glm-latest[1m]"],
            excludes: [FIREROUTER_MODEL],
          });
        }
        assert.equal(settings.apiKeyHelper, undefined);
        assert.match(headers, new RegExp(`X-Fireworks-Api-Key: ${FIREWORKS_KEY}`));
        assert.match(headers, /X-Title: Claude Code/);
        assert.ok(headers.includes(`HTTP-Referer: ${FIRECONNECT_REFERER}`), headers);
        assert.doesNotMatch(headers, /x-anthropic-api-key:/i);
        assert.doesNotMatch(enabled.stdout, /FireRouter off/);
        assert.doesNotMatch(enabled.stdout, /Sign in to Claude/);

        if (scenario.subscription) {
          assert.equal(await readFile(credentialsPath, "utf8"), SUBSCRIPTION_CREDENTIALS);
        } else {
          assert.equal(await pathExists(credentialsPath), false);
        }

        const disabled = await runFireconnect(["claude", "off"], env);
        assert.equal(disabled.code, 0, disabled.stderr);
        if (scenario.subscription) {
          assert.equal(await readFile(settingsPath, "utf8"), SUBSCRIPTION_SETTINGS);
          assert.equal(await readFile(credentialsPath, "utf8"), SUBSCRIPTION_CREDENTIALS);
        } else {
          assert.equal(await pathExists(settingsPath), false);
          assert.equal(await pathExists(credentialsPath), false);
        }
      });
    });
  }

  it("fresh auto default works without any Anthropic key (workspace BYOK removed)", async () => {
    await withTempHome("claude-no-byok-", async (home) => {
      seedCatalogFor(home);
      const result = await runFireconnect(
        ["claude", "on", "--api-key", FIREWORKS_KEY],
        {
          HOME: home,
          FIREWORKS_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
        },
      );
      assert.equal(result.code, 0, result.stderr);

      const settings = JSON.parse(
        await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8"),
      );
      assert.equal(settings.model, "auto[1m]");
      assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
      assertClaudeNativeTierSlots(settings);
      assertClaudeRegisterablePicker(settings, { includes: ["auto[1m]"], excludes: ["firerouter[1m]"] });
      assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
    });
  });

});
