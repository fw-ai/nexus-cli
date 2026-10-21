import test from "node:test";
import assert from "node:assert/strict";

import {
  createFormState,
  applyKey,
  formResult,
  curatedChallengers,
  curatedDemoModels,
  renderFormLines,
  estimateRaceCost,
} from "../../lib/demo/setup-form.mjs";
import { CUSTOM_MATCHUP_ID, demoMatchupOptionIds } from "../../lib/demo/demo-matchups.mjs";
import { CUSTOM_DEMO_PROMPT_ID, demoPromptOptionIds } from "../../lib/demo/presets.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModelRows } from "../helpers.mjs";

const CUSTOM_MATCHUP_INDEX = demoMatchupOptionIds().indexOf(CUSTOM_MATCHUP_ID);
const CUSTOM_PROMPT_INDEX = demoPromptOptionIds().indexOf(CUSTOM_DEMO_PROMPT_ID);

const DEFAULTS = {
  promptSource: "preset",
  promptPresetId: "tetris",
  leftModel: "opus",
  rightModel: "glm-fast-latest",
  matchupPresetId: "subscription-vs-fireworks",
  out: "./nexus-demo",
};

function state(overrides = {}) {
  return createFormState({ defaults: { ...DEFAULTS, ...overrides.defaults } });
}

function advanceToGame(s) {
  let cur = applyKey(s, "enter");
  return cur;
}

function advanceToConfirm(s) {
  let cur = advanceToGame(s);
  cur = applyKey(cur, "enter");
  return cur;
}

/**
 * Cycle a wizard picker to its custom option. `right` wraps, so the walk is
 * bounded by the option count rather than looping until a hardcoded index.
 */
function cycleTo(s, indexOf, target, optionCount) {
  let cur = s;
  for (let step = 0; step < optionCount && indexOf(cur) !== target; step += 1) {
    cur = applyKey(cur, "right");
  }
  assert.equal(indexOf(cur), target);
  return cur;
}

function selectCustomMatchup(s) {
  return cycleTo(s, (cur) => cur.matchupIndex, CUSTOM_MATCHUP_INDEX, demoMatchupOptionIds().length);
}

function selectCustomPrompt(s) {
  return cycleTo(s, (cur) => cur.promptIndex, CUSTOM_PROMPT_INDEX, demoPromptOptionIds().length);
}

test("createFormState: starts on matchup step", () => {
  const s = state();
  assert.equal(s.step, "matchup");
  assert.equal(s.leftModel, "opus");
});

test("applyKey: preset matchup enter advances to game step", () => {
  const s = advanceToGame(state());
  assert.equal(s.step, "game");
  assert.equal(s.leftModel, "opus");
  assert.equal(s.rightModel, "glm-fast-latest");
});

test("applyKey: custom matchup stays on step 1 with inline model pickers", () => {
  let s = selectCustomMatchup(state());
  assert.equal(CUSTOM_MATCHUP_ID, "custom");
  assert.equal(s.step, "matchup");
  s = applyKey(s, "down");
  assert.equal(s.focus, "models");
  s = applyKey(s, "right");
  assert.equal(s.matchupIndex, CUSTOM_MATCHUP_INDEX);
});

test("applyKey: editing models switches preset to custom", () => {
  let s = state();
  s = applyKey(s, "down");
  s = applyKey(s, "right");
  assert.equal(s.matchupIndex, CUSTOM_MATCHUP_INDEX);
});

test("applyKey: same model blocked on confirm", () => {
  let s = advanceToConfirm(state());
  s = { ...s, leftModel: "opus", rightModel: "opus" };
  s = applyKey(s, "enter");
  assert.equal(s.done, false);
  assert.match(s.error, /different models/);
});

test("applyKey: s swaps models on confirm", () => {
  let s = advanceToConfirm(state());
  s = applyKey(s, "s");
  assert.equal(s.leftModel, "glm-fast-latest");
  assert.equal(s.rightModel, "opus");
  assert.equal(s.matchupIndex, CUSTOM_MATCHUP_INDEX);
  assert.equal(formResult(s, { defaults: DEFAULTS }).matchupPresetId, "custom");
});

test("applyKey: confirm b goes back to game step", () => {
  let s = advanceToConfirm(state());
  s = applyKey(s, "b");
  assert.equal(s.step, "game");
});

test("applyKey: q inserts into custom prompt text", () => {
  let s = selectCustomPrompt(advanceToGame(state()));
  s = applyKey(s, "q");
  assert.equal(s.quit, false);
  assert.equal(s.customPromptText, "q");
});

test("formResult: custom matchup preset id preserved", () => {
  let s = state({ defaults: { ...DEFAULTS, matchupPresetId: "custom" } });
  s = applyKey(s, "enter");
  s = applyKey(s, "enter");
  s = applyKey(s, "enter");
  const r = formResult(s, { defaults: DEFAULTS });
  assert.equal(r.matchupPresetId, "custom");
});

test("applyKey: confirm enter finishes", () => {
  let s = advanceToConfirm(state());
  s = applyKey(s, "enter");
  assert.equal(s.done, true);
  const r = formResult(s, { defaults: DEFAULTS });
  assert.equal(r.prompt, "tetris");
  assert.equal(r.leftModel, "opus");
  assert.equal(r.matchupPresetId, "subscription-vs-fireworks");
});

test("applyKey: custom game requires text", () => {
  let s = selectCustomPrompt(advanceToGame(state()));
  s = applyKey(s, "enter");
  assert.equal(s.step, "game");
  assert.match(s.error, /custom task/i);
});

test("formResult: custom prompt preserved", () => {
  let s = selectCustomPrompt(advanceToGame(state()));
  for (const ch of "build timer") {
    s = applyKey(s, ch);
  }
  s = applyKey(s, "enter");
  s = applyKey(s, "enter");
  const r = formResult(s, { defaults: DEFAULTS });
  assert.equal(r.prompt, "build timer");
  assert.equal(r.promptSource, "literal");
});

test("renderFormLines: uses consistent 3-step numbering", () => {
  const matchup = renderFormLines(state(), { cols: 100 }).join("\n");
  assert.match(matchup, /1\/3 · Pick models/);
  assert.match(matchup, /Model A:/);
  const game = renderFormLines(advanceToGame(state()), { cols: 100 }).join("\n");
  assert.match(game, /2\/3 · Pick a challenge/);
  const confirm = renderFormLines(advanceToConfirm(state()), { cols: 100 }).join("\n");
  assert.match(confirm, /3\/3 · Confirm/);
  assert.match(confirm, /Nexus Claude setup/);
});

test("estimateRaceCost: returns a bounded range", () => {
  // `glm-fast-latest` is an API-reported alias, so warm a fast-tier catalog row
  // carrying it before pricing the challenger side.
  setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(
    mockServerlessModelRows({
      name: "accounts/fireworks/models/glm-5p2",
      aliases: ["accounts/fireworks/routers/glm-fast-latest"],
    }),
  ));
  try {
    const est = estimateRaceCost("opus", "glm-fast-latest");
    assert.ok(est);
    assert.ok(est.low < est.high);
  } finally {
    setServerlessCatalogSnapshot(null);
  }
});

test("curatedDemoModels: includes Anthropic slots and latest Fireworks picks", () => {
  const list = curatedDemoModels();
  const ids = list.map((m) => m.id);
  assert.ok(ids.includes("opus"));
  assert.ok(ids.includes("auto"));
  assert.ok(!ids.some((id) => id.startsWith("firerouter")));
  assert.ok(!ids.includes("glm-5p2-fast"));
});

test("curatedChallengers: excludes Anthropic subscription slots", () => {
  const list = curatedChallengers();
  assert.ok(!list.some((m) => m.id === "opus"));
});

test("applyKey: q quits from any step", () => {
  assert.equal(applyKey(state(), "q").quit, true);
  assert.equal(applyKey(advanceToGame(state()), "q").quit, true);
});
