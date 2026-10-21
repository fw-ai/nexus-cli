import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  readGlobalConfig,
  setHarnessState,
} from "../../../lib/config/global-config.mjs";
import {
  mappingFromSettings,
  providerStatePath,
  userSettingsPath,
} from "../../../lib/harnesses/claude/core.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import {
  defaultClaudeModelMapping,
  savedClaudeModelMapping,
  withSavedClaudeModelMapping,
} from "../../../lib/harnesses/claude/model-profile.mjs";
import { readJsonIfExists, writeJson } from "../../../lib/io/json.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { cacheServerlessCatalogSnapshot, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  mockServerlessModel,
  mockServerlessModelRows,
  runFireconnect,
  assertClaudeNativeTierSlots,
  assertClaudeRegisterablePicker,
} from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_test_key_12345";

/** Persist the alias catalog a spawned CLI child validates and resolves slots through. */
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
      ...mockServerlessModelRows({
        name: "accounts/fireworks/models/glm-5p2",
        aliases: ["accounts/fireworks/routers/glm-fast-latest"],
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        input_modalities: ["text", "image"],
        aliases: ["accounts/fireworks/routers/kimi-latest", "accounts/fireworks/routers/kimi-fast-latest"],
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
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

function cliEnv(home, apiKey = FIREWORKS_KEY) {
  return {
    HOME: home,
    FIREWORKS_API_KEY: apiKey,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  };
}

async function activeMapping(home) {
  const settings = await readJsonIfExists(userSettingsPath(home));
  return mappingFromSettings(settings);
}

async function hideManagedKeyMetadata(home) {
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  delete settings.env.ANTHROPIC_API_KEY;
  settings.env.ANTHROPIC_CUSTOM_HEADERS = settings.env.ANTHROPIC_CUSTOM_HEADERS
    .split("\n")
    .filter((line) => !/^X-Fireworks-Api-Key:/i.test(line))
    .join("\n");
  await writeJson(settingsPath, settings);

  const statePath = providerStatePath(path.join(home, ".nexus/claude"));
  const state = await readJsonIfExists(statePath);
  delete state.keyType;
  await writeJson(statePath, state);
}

describe("Claude model preferences", () => {
  it("merges stored profiles, keeps native tiers, and survives off/on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-prefs-"));
    seedCatalogFor(home);
    const env = cliEnv(home);
    await writeJson(userSettingsPath(home), {
      env: { ANTHROPIC_API_KEY: "sk-ant-native-test" },
    });
    const first = await runFireconnect([
      "claude", "on",
      "--model", "glm-latest",
    ], env);
    assert.equal(first.code, 0, first.stderr);

    const settingsAfterFirst = await readJsonIfExists(userSettingsPath(home));
    assert.equal(settingsAfterFirst.model, "glm-latest[1m]");
    assertClaudeNativeTierSlots(settingsAfterFirst);
    assertClaudeRegisterablePicker(settingsAfterFirst, { includes: ["glm-latest[1m]"] });

    const storedConfig = await readGlobalConfig(home);
    const staleProfiles = withSavedClaudeModelMapping(
      storedConfig.harnesses.claude.profiles,
      {
        ...defaultClaudeModelMapping(),
        main: "kimi-fast-latest",
      },
    );
    await setHarnessState(home, "claude", { profiles: staleProfiles });
    const reon = await runFireconnect(
      ["claude", "on", "--model", "kimi-fast-latest"],
      env,
    );
    assert.equal(reon.code, 0, reon.stderr);
    const settingsAfterReon = await readJsonIfExists(userSettingsPath(home));
    assert.equal(settingsAfterReon.model, "kimi-fast-latest[1m]");
    assertClaudeRegisterablePicker(settingsAfterReon, { includes: ["kimi-fast-latest[1m]"] });
    assert.deepEqual(
      savedClaudeModelMapping((await readGlobalConfig(home)).harnesses.claude.profiles),
      defaultClaudeModelMapping(),
    );

    const off = await runFireconnect(["claude", "off"], env);
    assert.equal(off.code, 0, off.stderr);
    const onAgain = await runFireconnect(["claude", "on", "--non-interactive"], env);
    assert.equal(onAgain.code, 0, onAgain.stderr);
    assert.match(onAgain.stdout, /Manage models/);
    assert.match(onAgain.stdout, /nexus claude --model <id>/);
    // Live main reflects the pinned auto default; the saved profile
    // mapping stays native (checked above).
    assert.deepEqual(await activeMapping(home), {
      ...defaultClaudeModelMapping(),
      main: "auto",
    });
    const settings = await readJsonIfExists(userSettingsPath(home));
    assert.equal(settings.model, "auto[1m]");
    assert.equal(settings.env.ANTHROPIC_MODEL, undefined);

    const config = await readGlobalConfig(home);
    assert.deepEqual(
      savedClaudeModelMapping(config.harnesses.claude.profiles),
      defaultClaudeModelMapping(),
    );
  });

  it("drops a stored FireRouter default to auto when native auth is undetectable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-prefs-"));
    seedCatalogFor(home);
    const settingsPath = userSettingsPath(home);
    const env = cliEnv(home);
    // What an earlier release left behind for `claude on --model firerouter`:
    // a FireRouter default pinned in settings, with no detectable native auth.
    await writeJson(settingsPath, {
      model: "firerouter[1m]",
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${FIREWORKS_KEY}`,
      },
    });
    const restored = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      env,
    );
    assert.equal(restored.code, 0, restored.stderr);
    const settings = await readJsonIfExists(settingsPath);
    assert.equal(settings.model, "auto[1m]");
    assertClaudeNativeTierSlots(settings);
    assertClaudeRegisterablePicker(settings, { includes: ["auto[1m]"], excludes: ["firerouter[1m]"] });
  });

  it("reconnects with native tiers when the managed key is temporarily unreadable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-live-prefs-"));
    const settingsPath = userSettingsPath(home);
    const env = cliEnv(home);
    const first = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      env,
    );
    assert.equal(first.code, 0, first.stderr);

    const settings = await readJsonIfExists(settingsPath);
    settings.model = "glm-latest[1m]";
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
    settings.env.ANTHROPIC_CUSTOM_HEADERS = settings.env.ANTHROPIC_CUSTOM_HEADERS
      .split("\n")
      .filter((line) => !/^X-Fireworks-Api-Key:/i.test(line))
      .join("\n");
    await writeJson(settingsPath, settings);

    const state = await readJsonIfExists(
      providerStatePath(path.join(home, ".nexus/claude")),
    );
    assert.equal(state.keyType, "fireworks");
    const reon = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      env,
    );
    assert.equal(reon.code, 0, reon.stderr);
    const after = await readJsonIfExists(settingsPath);
    assert.equal(after.model, "auto[1m]");
    assertClaudeNativeTierSlots(after);
  });
});
