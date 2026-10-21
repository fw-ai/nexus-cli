import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  demoPreferencesPath,
  loadDemoPreferences,
  saveDemoPreferences,
} from "../../lib/demo/demo-preferences.mjs";
import { resolveDemoWizardDefaults } from "../../lib/demo/demo-defaults.mjs";
import {
  defaultLeftModel,
  refreshDemoPickerFromServerlessCatalog,
} from "../../lib/demo/demo-models.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel } from "../helpers.mjs";
import {
  assessDemoReadiness,
  formatReadinessError,
  FIRECONNECT_REQUIRED_MSG,
} from "../../lib/demo/demo-readiness.mjs";
import {
  CUSTOM_MATCHUP_ID,
  demoMatchupOptionIds,
  demoMatchupPreset,
} from "../../lib/demo/demo-matchups.mjs";

// Alias routers (`glm-fast-latest`, `kimi-fast-latest`, `glm-latest`) are only
// offered via the API's per-row `aliases` after the refactor, so warm the demo
// picker with them before resolving wizard defaults against them.
const WIZARD_ALIAS_ROWS = [
  mockServerlessModel({
    name: "accounts/fireworks/models/glm-5p2",
    aliases: [
      "accounts/fireworks/routers/glm-latest",
      "accounts/fireworks/routers/glm-fast-latest",
    ],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/kimi-k3",
    aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
  }),
];

/** Run `fn` with the demo picker warmed from a catalog of latest aliases. */
function withDemoCatalog(fn) {
  setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(WIZARD_ALIAS_ROWS));
  refreshDemoPickerFromServerlessCatalog();
  try {
    return fn();
  } finally {
    setServerlessCatalogSnapshot(null);
    refreshDemoPickerFromServerlessCatalog();
  }
}

test("demoMatchupOptionIds: lists presets then custom", () => {
  const ids = demoMatchupOptionIds();
  assert.deepEqual(ids.slice(0, 3), [
    "subscription-vs-fireworks",
    "router-vs-direct",
    "speed-duel",
  ]);
  assert.equal(ids.at(-1), CUSTOM_MATCHUP_ID);
});

test("demoMatchupPreset: resolves known preset", () => {
  const preset = demoMatchupPreset("router-vs-direct");
  assert.ok(preset);
  assert.equal(preset.leftModel, "auto");
  assert.equal(preset.rightModel, "glm-fast-latest");
});

test("demoMatchupPreset: default preset uses clear model names in label", () => {
  const preset = demoMatchupPreset("subscription-vs-fireworks");
  assert.ok(preset);
  assert.equal(preset.label, "Claude Opus vs Fireworks");
  assert.doesNotMatch(preset.label, /subscription/i);
});

test("resolveDemoWizardDefaults: CLI overrides beat saved prefs", () => withDemoCatalog(() => {
  const resolved = resolveDemoWizardDefaults({
    cliLeft: "sonnet",
    cliRight: "kimi-fast-latest",
    saved: {
      leftModel: "opus",
      rightModel: "glm-fast-latest",
      matchupPresetId: "speed-duel",
    },
  });
  assert.equal(resolved.leftModel, "sonnet");
  assert.equal(resolved.rightModel, "kimi-fast-latest");
  assert.equal(resolved.matchupPresetId, CUSTOM_MATCHUP_ID);
}));

test("resolveDemoWizardDefaults: saved matchup applies when no CLI models", () => {
  const resolved = resolveDemoWizardDefaults({
    saved: {
      leftModel: "opus",
      rightModel: "glm-fast-latest",
      matchupPresetId: "router-vs-direct",
    },
  });
  assert.equal(resolved.leftModel, "auto");
  assert.equal(resolved.rightModel, "glm-fast-latest");
});

test("resolveDemoWizardDefaults: restores saved custom matchup models", () => {
  const resolved = resolveDemoWizardDefaults({
    saved: {
      leftModel: "sonnet",
      rightModel: "firerouter",
      matchupPresetId: "custom",
    },
  });
  assert.equal(resolved.leftModel, "sonnet");
  // A saved FireRouter model is retired: the pair sanitizer falls back.
  assert.equal(resolved.rightModel, "glm-fast-latest");
  assert.equal(resolved.matchupPresetId, "custom");
});

test("resolveDemoWizardDefaults: saved custom duplicate pair is deduped", () => {
  const resolved = resolveDemoWizardDefaults({
    saved: {
      leftModel: "opus",
      rightModel: "opus",
      matchupPresetId: "custom",
    },
  });
  assert.notEqual(resolved.leftModel, resolved.rightModel);
});

test("resolveDemoWizardDefaults: saved custom ignores stale catalog ids", () => {
  const resolved = resolveDemoWizardDefaults({
    saved: {
      leftModel: "glm-5p2-fast",
      rightModel: "firerouter",
      matchupPresetId: "custom",
    },
  });
  assert.equal(resolved.leftModel, defaultLeftModel());
  assert.equal(resolved.rightModel, "glm-fast-latest");
});

test("resolveDemoWizardDefaults: dedupes identical left/right", () => {
  const resolved = resolveDemoWizardDefaults({
    cliLeft: "opus",
    cliRight: "opus",
  });
  assert.notEqual(resolved.leftModel, resolved.rightModel);
});

test("resolveDemoWizardDefaults: fresh run selects the first matchup option, not custom", () => {
  // No saved prefs, no CLI overrides — the wizard must open on the first
  // option ("Claude Opus vs Fireworks") with its models, not drift to custom.
  const resolved = resolveDemoWizardDefaults({});
  assert.equal(resolved.matchupPresetId, "subscription-vs-fireworks");
  assert.equal(resolved.leftModel, "opus");
  assert.equal(resolved.rightModel, "glm-fast-latest");
});

test("resolveDemoWizardDefaults: fresh run ignores live status mapping drift", () => {
  // Even when the user's live Claude opus slot is a Fireworks model (which used
  // to seed the right side and drift to custom), a fresh run stays on the first
  // matchup option.
  const resolved = resolveDemoWizardDefaults({
    readinessMapping: { opus: "glm-fast-latest", main: "glm-fast-latest" },
  });
  assert.equal(resolved.matchupPresetId, "subscription-vs-fireworks");
  assert.equal(resolved.leftModel, "opus");
  assert.equal(resolved.rightModel, "glm-fast-latest");
});

test("resolveDemoWizardDefaults: dedupes identical default-right pairs", () => withDemoCatalog(() => {
  const resolved = resolveDemoWizardDefaults({
    cliLeft: "glm-fast-latest",
    cliRight: "glm-fast-latest",
  });
  assert.equal(resolved.leftModel, "glm-fast-latest");
  assert.equal(resolved.rightModel, defaultLeftModel());
  assert.notEqual(resolved.leftModel, resolved.rightModel);
  assert.equal(resolved.matchupPresetId, CUSTOM_MATCHUP_ID);
}));

test("resolveDemoWizardDefaults: saved custom default-right pair is deduped", () => {
  const resolved = resolveDemoWizardDefaults({
    saved: {
      leftModel: "glm-fast-latest",
      rightModel: "glm-fast-latest",
      matchupPresetId: "custom",
    },
  });
  assert.notEqual(resolved.leftModel, resolved.rightModel);
  assert.equal(resolved.matchupPresetId, CUSTOM_MATCHUP_ID);
});

test("resolveDemoWizardDefaults: sanitize that flips orientation marks custom", () => withDemoCatalog(() => {
  const resolved = resolveDemoWizardDefaults({
    cliLeft: "glm-fast-latest",
    cliRight: "glm-fast-latest",
    saved: { matchupPresetId: "subscription-vs-fireworks" },
  });
  assert.equal(resolved.leftModel, "glm-fast-latest");
  assert.equal(resolved.rightModel, "opus");
  assert.equal(resolved.matchupPresetId, CUSTOM_MATCHUP_ID);
}));

test("resolveDemoWizardDefaults: keeps curated id when models still match", () => {
  const resolved = resolveDemoWizardDefaults({
    cliLeft: "opus",
    cliRight: "opus",
    saved: { matchupPresetId: "subscription-vs-fireworks" },
  });
  assert.equal(resolved.leftModel, "opus");
  assert.equal(resolved.rightModel, "glm-fast-latest");
  assert.equal(resolved.matchupPresetId, "subscription-vs-fireworks");
});

test("demo preferences: round-trip under ~/.nexus/demo.json", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-demo-prefs-"));
  try {
    const prefsPath = demoPreferencesPath(home);
    assert.match(prefsPath, /demo\.json$/);
    await saveDemoPreferences(home, {
      leftModel: "opus",
      rightModel: "glm-fast-latest",
      promptPresetId: "snake",
      matchupPresetId: "subscription-vs-fireworks",
    });
    const loaded = await loadDemoPreferences(home);
    assert.deepEqual(loaded, {
      leftModel: "opus",
      rightModel: "glm-fast-latest",
      promptPresetId: "snake",
      matchupPresetId: "subscription-vs-fireworks",
    });
    const raw = JSON.parse(await readFile(prefsPath, "utf8"));
    assert.equal(raw.matchupPresetId, "subscription-vs-fireworks");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("assessDemoReadiness: empty home reports claude off", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-demo-ready-"));
  try {
    const readiness = await assessDemoReadiness({ home });
    assert.equal(readiness.claudeOn, false);
    assert.equal(readiness.ok, false);
    assert.match(formatReadinessError(readiness), new RegExp(FIRECONNECT_REQUIRED_MSG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
