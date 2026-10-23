import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { readGlobalConfig, writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import {
  defaultClaudeModelMapping,
  savedClaudeModelMapping,
  withSavedClaudeModelMapping,
} from "../../../lib/harnesses/claude/model-profile.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import {
  providerBackupPath,
  providerStatePath,
  resolveDataDir,
  userSettingsPath,
} from "../../../lib/harnesses/claude/core.mjs";
import {
  migrateClaudeExploreInheritCapOnUpgrade,
  migrateClaudeFirerouterOnUpgrade,
  migrateClaudeModelPickerOnUpgrade,
  migrateClaudeNativeWebSearchOnUpgrade,
  migrateClaudeRetiredAutoModeServerPinOnUpgrade,
  migrateClaudeRetiredAutoUpdatePinOnUpgrade,
  migrateClaudeTelemetryOptOutsOnUpgrade,
  migrateClaudeToolSearchOnUpgrade,
} from "../../../lib/harnesses/claude/upgrade-migrations.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import {
  cacheServerlessCatalogSnapshot,
  setServerlessCatalogSnapshot,
} from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel } from "../../helpers.mjs";
import {
  WEBSEARCH_MCP_SERVER_NAME,
  claudeJsonPath,
} from "../../../lib/system/websearch-state.mjs";
import { withTempHome } from "../../helpers.mjs";

async function seedSettings(home, settings, { enabled = true } = {}) {
  await writeGlobalConfig(home, {
    harnesses: { claude: { enabled, provider: "fireworks" } },
  });
  const settingsPath = userSettingsPath(home);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const raw = `${JSON.stringify(settings, null, 2)}\n`;
  await writeFile(settingsPath, raw, { mode: 0o600 });
  return { settingsPath, raw };
}

describe("migrateClaudeToolSearchOnUpgrade", () => {
  it("adds ENABLE_TOOL_SEARCH to managed settings, preserving everything else", async () => {
    await withTempHome("claude-tool-search-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345",
          MY_CUSTOM_VAR: "keep-me",
        },
        permissions: { deny: ["WebSearch"] },
      });

      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.ENABLE_TOOL_SEARCH, "true");
      assert.equal(settings.env.MY_CUSTOM_VAR, "keep-me");
      assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, "X-Fireworks-Api-Key: fw_test_key_12345");
      assert.deepEqual(settings.permissions.deny, ["WebSearch"]);
      // The rewrite must not widen the mode: the file holds the Fireworks key.
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("leaves a value the user already set alone", async () => {
    await withTempHome("claude-tool-search-user-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ENABLE_TOOL_SEARCH: "false",
        },
      });

      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("no-ops on settings FireConnect does not route to Fireworks", async () => {
    await withTempHome("claude-tool-search-native-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      });

      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("no-ops when there is no settings file", async () => {
    await withTempHome("claude-tool-search-missing-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), false);
    });
  });

  it("leaves settings alone when the harness is off", async () => {
    await withTempHome("claude-tool-search-off-", async (home) => {
      const { raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      }, { enabled: false });

      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), false);
      assert.equal(await readFile(userSettingsPath(home), "utf8"), raw);
    });
  });
});

describe("migrateClaudeRetiredAutoModeServerPinOnUpgrade", () => {
  it("removes the retired pin from managed settings, preserving everything else", async () => {
    await withTempHome("claude-auto-mode-server-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345",
          CLAUDE_CODE_AUTO_MODE_SERVER: "0",
          MY_CUSTOM_VAR: "keep-me",
        },
      });

      assert.equal(await migrateClaudeRetiredAutoModeServerPinOnUpgrade(home), true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(Object.hasOwn(settings.env, "CLAUDE_CODE_AUTO_MODE_SERVER"), false);
      assert.equal(settings.env.MY_CUSTOM_VAR, "keep-me");
      assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, "X-Fireworks-Api-Key: fw_test_key_12345");
      // The rewrite must not widen the mode: the file holds the Fireworks key.
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("keeps a pin the user had before connecting", async () => {
    await withTempHome("claude-auto-mode-server-own-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_AUTO_MODE_SERVER: "0",
        },
      });
      const backupPath = providerBackupPath(resolveDataDir({ home }));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({
        configPath: settingsPath,
        snapshot: {
          existed: true,
          raw: JSON.stringify({ env: { CLAUDE_CODE_AUTO_MODE_SERVER: "0" } }),
        },
      }));

      assert.equal(await migrateClaudeRetiredAutoModeServerPinOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("restores a different value the user had before connecting", async () => {
    await withTempHome("claude-auto-mode-server-restore-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_AUTO_MODE_SERVER: "0",
        },
      });
      const backupPath = providerBackupPath(resolveDataDir({ home }));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({ values: { CLAUDE_CODE_AUTO_MODE_SERVER: "1" } }));

      assert.equal(await migrateClaudeRetiredAutoModeServerPinOnUpgrade(home), true);
      const { env } = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(env.CLAUDE_CODE_AUTO_MODE_SERVER, "1");
    });
  });

  it("keeps a pin recorded in a legacy values-only backup", async () => {
    await withTempHome("claude-auto-mode-server-legacy-", async (home) => {
      const { raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_AUTO_MODE_SERVER: "0",
        },
      });
      const backupPath = providerBackupPath(resolveDataDir({ home }));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({ values: { CLAUDE_CODE_AUTO_MODE_SERVER: "0" } }));

      assert.equal(await migrateClaudeRetiredAutoModeServerPinOnUpgrade(home), false);
      assert.equal(await readFile(userSettingsPath(home), "utf8"), raw);
    });
  });

  it("leaves any other value alone", async () => {
    await withTempHome("claude-auto-mode-server-user-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_AUTO_MODE_SERVER: "1",
        },
      });

      assert.equal(await migrateClaudeRetiredAutoModeServerPinOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("no-ops on settings FireConnect does not route to Fireworks", async () => {
    await withTempHome("claude-auto-mode-server-native-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          CLAUDE_CODE_AUTO_MODE_SERVER: "0",
        },
      });

      assert.equal(await migrateClaudeRetiredAutoModeServerPinOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("leaves settings alone when the harness is off", async () => {
    await withTempHome("claude-auto-mode-server-off-", async (home) => {
      const { raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_AUTO_MODE_SERVER: "0",
        },
      }, { enabled: false });

      assert.equal(await migrateClaudeRetiredAutoModeServerPinOnUpgrade(home), false);
      assert.equal(await readFile(userSettingsPath(home), "utf8"), raw);
    });
  });
});

describe("migrateClaudeRetiredAutoUpdatePinOnUpgrade", () => {
  it("removes the retired pin from managed settings, preserving everything else", async () => {
    await withTempHome("claude-auto-update-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "0",
          MY_CUSTOM_VAR: "keep-me",
        },
      });

      assert.equal(await migrateClaudeRetiredAutoUpdatePinOnUpgrade(home), true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(Object.hasOwn(settings.env, "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE"), false);
      assert.equal(settings.env.MY_CUSTOM_VAR, "keep-me");
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("keeps a pin the user had before connecting, and any other value", async () => {
    await withTempHome("claude-auto-update-own-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "0",
        },
      });
      const backupPath = providerBackupPath(resolveDataDir({ home }));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({
        configPath: settingsPath,
        snapshot: {
          existed: true,
          raw: JSON.stringify({ env: { CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "0" } }),
        },
      }));
      assert.equal(await migrateClaudeRetiredAutoUpdatePinOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
    await withTempHome("claude-auto-update-on-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "1",
        },
      });
      assert.equal(await migrateClaudeRetiredAutoUpdatePinOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("leaves settings alone when the harness is off", async () => {
    await withTempHome("claude-auto-update-off-", async (home) => {
      const { raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "0",
        },
      }, { enabled: false });

      assert.equal(await migrateClaudeRetiredAutoUpdatePinOnUpgrade(home), false);
      assert.equal(await readFile(userSettingsPath(home), "utf8"), raw);
    });
  });
});

describe("migrateClaudeTelemetryOptOutsOnUpgrade", () => {
  const OPT_OUTS = {
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };

  async function seedBackup(home, settingsPath, env) {
    const backupPath = providerBackupPath(resolveDataDir({ home }));
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, JSON.stringify({
      configPath: settingsPath,
      snapshot: { existed: true, raw: JSON.stringify({ env }) },
    }));
  }

  it("removes the opt-outs Nexus wrote, preserving everything else", async () => {
    await withTempHome("claude-telemetry-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345",
          ...OPT_OUTS,
          MY_CUSTOM_VAR: "keep-me",
        },
      });

      assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      for (const key of Object.keys(OPT_OUTS)) {
        assert.equal(Object.hasOwn(settings.env, key), false, key);
      }
      assert.equal(settings.env.MY_CUSTOM_VAR, "keep-me");
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("keeps or restores the user's own pre-Nexus values", async () => {
    await withTempHome("claude-telemetry-own-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL, ...OPT_OUTS },
      });
      await seedBackup(home, settingsPath, { DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "true" });

      assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), true);

      const { env } = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(env.DISABLE_TELEMETRY, "1");
      assert.equal(env.DO_NOT_TRACK, "true");
      assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"), false);
    });
  });

  it("keeps a lone opt-out the user set deliberately after on", async () => {
    await withTempHome("claude-telemetry-lone-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL, DISABLE_TELEMETRY: "1" },
      });

      assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("does not spend the once-only retirement on a partial set", async () => {
    await withTempHome("claude-telemetry-partial-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          DISABLE_TELEMETRY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      });
      assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), false);
      const statePath = providerStatePath(resolveDataDir({ home }));
      assert.equal(existsSync(statePath), false, "no marker written for a partial set");
      // Completing the Nexus-written set lets a later run retire it.
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.env.DO_NOT_TRACK = "1";
      await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
      assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), true);
    });
  });

  it("runs once, so an opt-out added afterwards stays", async () => {
    await withTempHome("claude-telemetry-once-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      });

      assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), false);
      const raw = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL, ...OPT_OUTS } })}\n`;
      await writeFile(settingsPath, raw, { mode: 0o600 });

      assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("leaves settings alone when the harness is off", async () => {
    await withTempHome("claude-telemetry-off-", async (home) => {
      const { raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL, ...OPT_OUTS },
      }, { enabled: false });

      assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), false);
      assert.equal(await readFile(userSettingsPath(home), "utf8"), raw);
      // No marker either, so the next `on` still cleans up.
      assert.equal(existsSync(providerStatePath(resolveDataDir({ home }))), false);
    });
  });

  it("honors a legacy values-only backup", async () => {
    await withTempHome("claude-telemetry-legacy-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL, ...OPT_OUTS },
      });
      const backupPath = providerBackupPath(resolveDataDir({ home }));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({
        values: { DISABLE_TELEMETRY: "1" },
        missing: ["DO_NOT_TRACK", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
      }));

      assert.equal(await migrateClaudeTelemetryOptOutsOnUpgrade(home), true);

      const { env } = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(env.DISABLE_TELEMETRY, "1");
      assert.equal(Object.hasOwn(env, "DO_NOT_TRACK"), false);
      assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"), false);
    });
  });
});

describe("migrateClaudeExploreInheritCapOnUpgrade", () => {
  it("lets Explore inherit the session model on managed settings", async () => {
    await withTempHome("claude-explore-inherit-cap-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          MY_CUSTOM_VAR: "keep-me",
        },
      });

      assert.equal(await migrateClaudeExploreInheritCapOnUpgrade(home), true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP, "1");
      assert.equal(settings.env.MY_CUSTOM_VAR, "keep-me");
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("leaves a value the user already set alone", async () => {
    await withTempHome("claude-explore-inherit-cap-user-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: "0",
        },
      });

      assert.equal(await migrateClaudeExploreInheritCapOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("no-ops when the harness is off or unrouted", async () => {
    await withTempHome("claude-explore-inherit-cap-off-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      }, { enabled: false });

      assert.equal(await migrateClaudeExploreInheritCapOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });
});

describe("migrateClaudeNativeWebSearchOnUpgrade", () => {
  it("removes the retired MCP and FireConnect's legacy WebSearch denial", async () => {
    await withTempHome("claude-native-websearch-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
        permissions: { deny: ["Bash(rm:*)", "WebSearch", "WebFetch"] },
      });
      const backupPath = providerBackupPath(resolveDataDir({ home }));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({
        configPath: settingsPath,
        snapshot: {
          existed: true,
          raw: JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
        },
      }));
      await writeFile(claudeJsonPath(home), JSON.stringify({
        mcpServers: {
          "user-server": { command: "echo" },
          [WEBSEARCH_MCP_SERVER_NAME]: { type: "http", url: "https://mcp.fireworks.ai/work/mcp" },
        },
      }));

      assert.equal(await migrateClaudeNativeWebSearchOnUpgrade(home), true);
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepEqual(settings.permissions.deny, ["Bash(rm:*)"]);
      const claudeJson = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
      assert.deepEqual(claudeJson.mcpServers, { "user-server": { command: "echo" } });
    });
  });

  it("preserves a WebSearch denial from the user's original snapshot", async () => {
    await withTempHome("claude-native-websearch-user-deny-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
        permissions: { deny: ["WebSearch", "WebFetch"] },
      });
      const backupPath = providerBackupPath(resolveDataDir({ home }));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({
        configPath: settingsPath,
        snapshot: {
          existed: true,
          raw: JSON.stringify({ permissions: { deny: ["WebSearch", "WebFetch"] } }),
        },
      }));

      assert.equal(await migrateClaudeNativeWebSearchOnUpgrade(home), false);
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepEqual(settings.permissions.deny, ["WebSearch", "WebFetch"]);
    });
  });
});

describe("migrateClaudeModelPickerOnUpgrade", () => {
  const CATALOG_ROWS = [
    mockServerlessModel({
      name: "accounts/fireworks/models/glm-5p3",
      displayName: "GLM 5.3",
      aliases: ["accounts/fireworks/routers/glm-latest"],
    }),
    mockServerlessModel({
      name: "accounts/fireworks/models/kimi-k3",
      displayName: "Kimi K3",
      aliases: ["accounts/fireworks/routers/kimi-latest"],
    }),
  ];

  async function seedCatalogFor(home) {
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(CATALOG_ROWS));
    } finally {
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
    }
  }

  // The catalog cache (and any env-HOME reader) resolves process.env.HOME
  // implicitly; the in-process migration needs the temp home there, matching
  // what a spawned CLI child gets via its env.
  async function withHome(home, fn) {
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      return await fn();
    } finally {
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
    }
  }

  const FIREWORKS_ENV = {
    ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
    ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345",
  };

  function managedPicker(options) {
    return { fireconnectManaged: true, replaceBuiltInOptions: false, options };
  }

  it("refreshes stale descriptions, prunes delisted rows, and keeps claude and current rows", async () => {
    await withTempHome("claude-picker-refresh-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: FIREWORKS_ENV,
        model: "deepseek-v4-flash[1m]",
        modelPicker: managedPicker([
          { model: "auto[1m]", label: "Auto", description: "STALE DESCRIPTION" },
          { model: "glm-latest[1m]", label: "GLM (OLD)", description: "old" },
          { model: "deepseek-v3[1m]", label: "Custom", description: "delisted extra" },
          { model: "deepseek-v4-flash[1m]", label: "Current", description: "current default" },
          { model: "claude-sonnet-4-6", label: "Mine", description: "user row" },
          { model: "firerouter/test-model[1m]", label: "Route", description: "route" },
          { model: "firerouter[1m]", label: "FireRouter", description: "old" },
        ]),
      });
      await seedCatalogFor(home);

      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), true);

      const options = JSON.parse(await readFile(settingsPath, "utf8"))
        .modelPicker.options;
      const byModel = Object.fromEntries(options.map((row) => [row.model, row]));
      assert.notEqual(byModel["auto[1m]"].description, "STALE DESCRIPTION");
      assert.notEqual(byModel["glm-latest[1m]"].description, "old");
      // A non-Claude row the catalog no longer serves is pruned.
      assert.equal(byModel["deepseek-v3[1m]"], undefined);
      // The current default survives the rebuild.
      assert.ok(byModel["deepseek-v4-flash[1m]"]);
      // Claude rows are kept verbatim.
      assert.deepEqual(byModel["claude-sonnet-4-6"], {
        model: "claude-sonnet-4-6",
        label: "Mine",
        description: "user row",
      });
      // New catalog rows appear.
      assert.ok(byModel["kimi-latest[1m]"]);
      // FireRouter rows are dropped, not preserved like other extras.
      assert.equal(byModel["firerouter[1m]"], undefined);
      assert.ok(!options.some((row) => row.model.startsWith("firerouter")));
      // The rewrite must not widen the mode: the file holds the Fireworks key.
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("is a no-op when the options are already current", async () => {
    await withTempHome("claude-picker-current-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: FIREWORKS_ENV,
        modelPicker: managedPicker([]),
      });
      await seedCatalogFor(home);
      // First run writes the current catalog; a second run must be a no-op.
      await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home));
      const afterFirst = await readFile(settingsPath, "utf8");
      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), false);
      assert.equal(await readFile(settingsPath, "utf8"), afterFirst);
      assert.notEqual(afterFirst, raw);
    });
  });

  it("leaves a user-authored (unmanaged) picker exactly as-is", async () => {
    await withTempHome("claude-picker-user-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: FIREWORKS_ENV,
        modelPicker: {
          replaceBuiltInOptions: false,
          options: [{ model: "auto[1m]", label: "My Auto", description: "mine" }],
        },
      });
      await seedCatalogFor(home);
      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("does nothing when the harness is off or not Fireworks-routed", async () => {
    await withTempHome("claude-picker-off-", async (home) => {
      const { settingsPath, raw } = await seedSettings(
        home,
        { env: FIREWORKS_ENV, modelPicker: managedPicker([{ model: "auto[1m]", label: "Auto", description: "x" }]) },
        { enabled: false },
      );
      await seedCatalogFor(home);
      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);

      const native = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        modelPicker: managedPicker([{ model: "auto[1m]", label: "Auto", description: "x" }]),
      });
      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), false);
      assert.equal(await readFile(native.settingsPath, "utf8"), native.raw);
    });
  });
});

describe("migrateClaudeFirerouterOnUpgrade", () => {
  it("moves the top-level default and tier-slot pins off FireRouter to auto", async () => {
    await withTempHome("claude-firerouter-drop-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        model: "firerouter[1m]",
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345\nx-anthropic-api-key: sk-ant-legacy\nx-openai-api-key: sk-proj-legacy\nX-User-Trace: keep",
          ANTHROPIC_MODEL: "firerouter[1m]",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "firerouter/opus[1m]",
          ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "FireRouter · Opus",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-latest[1m]",
          CLAUDE_CODE_SUBAGENT_MODEL: "firerouter[1m]",
        },
      });

      // A saved profile carrying a FireRouter slot, as an earlier `on` left it.
      const existing = await readGlobalConfig(home);
      await writeGlobalConfig(home, {
        harnesses: {
          ...existing.harnesses,
          claude: {
            enabled: true,
            provider: "fireworks",
            profiles: withSavedClaudeModelMapping({}, { ...defaultClaudeModelMapping(), opus: "firerouter/opus" }),
          },
        },
      });

      assert.equal(await migrateClaudeFirerouterOnUpgrade(home), true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.model, "auto[1m]");
      // BYOK lines that only served the dropped route are stripped; the
      // Fireworks key and user lines stay.
      // The Anthropic key line goes (Claude Code's login covers Claude turns);
      // the OpenAI key stays for Nexus Auto.
      assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, "X-Fireworks-Api-Key: fw_test_key_12345\nx-openai-api-key: sk-proj-legacy\nX-User-Trace: keep");
      assert.equal(savedClaudeModelMapping((await readGlobalConfig(home)).harnesses.claude.profiles).opus, "auto");
      // The legacy main override is removed, not rewritten: it would shadow settings.model.
      assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
      assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "auto[1m]");
      assert.notEqual(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "FireRouter · Opus");
      assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-latest[1m]", "concrete pins stay");
      assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, "auto[1m]");
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);

      assert.equal(await migrateClaudeFirerouterOnUpgrade(home), false, "second run is a no-op");
    });
  });

  it("pins auto when a pre-v0.9 install's only main default was the ANTHROPIC_MODEL override", async () => {
    await withTempHome("claude-firerouter-drop-legacy-main-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345",
          ANTHROPIC_MODEL: "firerouter[1m]",
        },
      });

      assert.equal(await migrateClaudeFirerouterOnUpgrade(home), true);
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
      assert.equal(settings.model, "auto[1m]", "the dropped override must not leave the main unpinned");
    });
  });

  it("keeps a concrete top-level model when removing the ANTHROPIC_MODEL override", async () => {
    await withTempHome("claude-firerouter-drop-legacy-main-keep-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        model: "glm-latest[1m]",
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345",
          ANTHROPIC_MODEL: "firerouter/opus[1m]",
        },
      });

      assert.equal(await migrateClaudeFirerouterOnUpgrade(home), true);
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
      assert.equal(settings.model, "glm-latest[1m]");
    });
  });

  it("leaves non-FireRouter installs and disabled harnesses alone", async () => {
    await withTempHome("claude-firerouter-drop-off-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        model: "glm-latest[1m]",
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      });
      assert.equal(await migrateClaudeFirerouterOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);

      const disabled = await seedSettings(home, {
        model: "firerouter[1m]",
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      }, { enabled: false });
      assert.equal(await migrateClaudeFirerouterOnUpgrade(home), false);
      assert.equal(await readFile(disabled.settingsPath, "utf8"), disabled.raw);
    });
  });
});
