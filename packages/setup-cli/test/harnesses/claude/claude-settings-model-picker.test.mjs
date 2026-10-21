import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFireconnectModelPickerOptions,
  INVALID_MODEL_PICKER_MESSAGE,
  isFireconnectModelPicker,
  stripFireconnectModelPicker,
  validateClaudeModelPicker,
  withFireconnectModelPicker,
} from "../../../lib/harnesses/claude/settings-model-picker.mjs";

describe("Claude settings modelPicker", () => {
  it("marks managed picker rows and keeps built-in Anthropic options", () => {
    const next = withFireconnectModelPicker({}, ["auto", "glm-latest"]);
    assert.equal(isFireconnectModelPicker(next.modelPicker), true);
    assert.equal(next.modelPicker.replaceBuiltInOptions, false);
    assert.deepEqual(
      next.modelPicker.options.map((row) => row.model),
      ["auto[1m]", "glm-latest[1m]"],
    );
  });

  it("appends missing rows to an existing modelPicker without changing its rows", () => {
    const settings = {
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [{ model: "claude-sonnet-4-6", label: "Mine" }],
      },
    };
    const next = withFireconnectModelPicker(settings, ["auto"]);
    assert.deepEqual(
      next.modelPicker.options.map((row) => row.model),
      ["claude-sonnet-4-6", "auto[1m]"],
    );
    assert.equal(next.modelPicker.fireconnectManaged, undefined);
  });

  it("appends missing rows after the FireConnect marker is stripped", () => {
    // What Claude Code leaves behind after persisting a /model pick: our rows,
    // our shape, but the unknown fireconnectManaged key stripped.
    const drifted = {
      modelPicker: {
        replaceBuiltInOptions: false,
        options: [
          { model: "firerouter[1m]", label: "FireRouter" },
          { model: "glm-latest[1m]", label: "GLM 5.3 (Latest)" },
        ],
      },
    };
    const next = withFireconnectModelPicker(drifted, ["firerouter", "glm-latest", "auto"]);
    assert.deepEqual(
      next.modelPicker.options.map((row) => row.model),
      ["firerouter[1m]", "glm-latest[1m]", "auto[1m]"],
    );
    assert.equal(next.modelPicker.fireconnectManaged, undefined);
  });

  it("refreshes a managed picker and dedupes normalized ids", () => {
    const settings = {
      modelPicker: {
        fireconnectManaged: true,
        options: [{ model: "glm-latest[1m]" }, { model: "kimi-latest" }],
      },
    };
    const next = withFireconnectModelPicker(settings, [
      "glm-latest",
      "accounts/fireworks/routers/glm-latest",
      "kimi-latest",
      "auto",
    ]);
    assert.deepEqual(
      next.modelPicker.options.map((row) => row.model),
      ["glm-latest[1m]", "kimi-latest", "auto[1m]"],
    );
  });

  it("refresh prunes delisted rows, re-renders kept rows, and keeps claude-* verbatim", () => {
    const settings = {
      modelPicker: {
        fireconnectManaged: true,
        replaceBuiltInOptions: false,
        options: [
          { model: "retired-model[1m]", label: "Retired", description: "gone" },
          { model: "claude-sonnet-4-6", label: "Mine", description: "user row" },
          { model: "opus", label: "My Opus", description: "alias row" },
          { model: "glm-latest[1m]", label: "OLD", description: "stale" },
          { model: "firerouter/test-model[1m]", label: "Old route", description: "stale" },
        ],
      },
    };
    const next = withFireconnectModelPicker(
      settings,
      ["glm-latest", "auto"],
      { refresh: true, protectedIds: ["custom-router", "claude-haiku-4-5"] },
    );
    const rows = next.modelPicker.options;
    assert.deepEqual(
      rows.slice(0, 2),
      [
        { model: "claude-sonnet-4-6", label: "Mine", description: "user row" },
        { model: "opus", label: "My Opus", description: "alias row" },
      ],
      "claude rows keep their exact rows and come first",
    );
    const ids = rows.map((row) => row.model);
    assert.ok(!ids.some((id) => id.includes("retired-model")), "delisted row pruned");
    assert.ok(ids.includes("glm-latest[1m]"));
    assert.ok(ids.includes("auto[1m]"), "new catalog row added");
    assert.ok(!ids.some((id) => id.startsWith("firerouter")), "FireRouter rows are pruned, not kept");
    assert.ok(ids.includes("custom-router[1m]") || ids.includes("custom-router"), "protected id kept");
    assert.ok(ids.includes("claude-haiku-4-5"), "protected concrete claude-* row rendered");
    assert.notEqual(rows.find((row) => row.model === "glm-latest[1m]").label, "OLD", "kept row re-rendered");
    assert.equal(ids.length, new Set(ids).size, "no duplicates");
    // A second refresh over the refreshed picker changes nothing.
    assert.equal(withFireconnectModelPicker(next, ["glm-latest", "auto"], { refresh: true, protectedIds: ["custom-router", "claude-haiku-4-5"] }), next);
  });

  it("refresh with an empty catalog leaves the picker untouched", () => {
    const settings = {
      modelPicker: {
        fireconnectManaged: true,
        options: [{ model: "glm-latest[1m]", label: "GLM" }],
      },
    };
    assert.equal(withFireconnectModelPicker(settings, [], { refresh: true }), settings);
    // Older callers synthesized the bare firerouter (and auto) rows even for
    // a vacant catalog; specials alone must not authorize a prune either.
    assert.equal(
      withFireconnectModelPicker(settings, ["firerouter"], { refresh: true, protectedIds: ["custom-router"] }),
      settings,
    );
    assert.equal(
      withFireconnectModelPicker(settings, ["firerouter", "auto"], { refresh: true }),
      settings,
    );
  });

  it("refresh dedupes claude-* rows by normalized id, keeping the first", () => {
    const settings = {
      modelPicker: {
        fireconnectManaged: true,
        options: [
          { model: "claude-opus-4-8", label: "First" },
          { model: "accounts/fireworks/models/claude-opus-4-8", label: "Second" },
        ],
      },
    };
    const next = withFireconnectModelPicker(settings, ["auto", "glm-latest"], { refresh: true });
    const claudeRows = next.modelPicker.options.filter((row) => row.model.includes("claude-opus"));
    assert.deepEqual(claudeRows, [{ model: "claude-opus-4-8", label: "First" }]);
  });

  it("leaves a complete picker unchanged", () => {
    const settings = withFireconnectModelPicker({}, ["auto"]);
    const refreshed = withFireconnectModelPicker(settings, ["auto", "auto"]);
    assert.equal(refreshed, settings);
    assert.deepEqual(refreshed.modelPicker.options.map((row) => row.model), ["auto[1m]"]);
  });

  it("rejects every malformed pre-existing picker value", () => {
    for (const modelPicker of [
      null,
      "invalid",
      [],
      42,
      { options: "invalid" },
      { options: [null] },
      { options: ["auto"] },
      { options: [{}] },
      { options: [{ model: "" }] },
      { options: [{ model: 42 }] },
    ]) {
      const settings = { modelPicker };
      assert.throws(
        () => withFireconnectModelPicker(settings, ["auto"]),
        (error) => error.message === INVALID_MODEL_PICKER_MESSAGE,
      );
      assert.throws(
        () => validateClaudeModelPicker(settings),
        (error) => error.message === INVALID_MODEL_PICKER_MESSAGE,
      );
    }
  });

  it("adds options when an existing modelPicker has no options field", () => {
    const next = withFireconnectModelPicker({ modelPicker: { replaceBuiltInOptions: false } }, ["auto"]);
    assert.deepEqual(next.modelPicker.options.map((row) => row.model), ["auto[1m]"]);
  });

  it("accepts a well-formed user picker", () => {
    assert.doesNotThrow(() => validateClaudeModelPicker({
      modelPicker: { options: [{ model: "claude-sonnet-4-6" }] },
    }));
  });

  it("strips only FireConnect-managed modelPicker blocks", () => {
    const managed = withFireconnectModelPicker({}, ["auto"]);
    const { settings: stripped, changed } = stripFireconnectModelPicker(managed);
    assert.equal(changed, true);
    assert.equal(stripped.modelPicker, undefined);

    const user = {
      modelPicker: { options: [{ model: "claude-opus-4-8" }] },
    };
    const kept = stripFireconnectModelPicker(user);
    assert.equal(kept.changed, false);
    assert.deepEqual(kept.settings, user);
  });

  it("buildFireconnectModelPickerOptions dedupes normalized ids", () => {
    const options = buildFireconnectModelPickerOptions([
      "auto",
      "auto",
      "glm-latest",
      "accounts/fireworks/routers/glm-latest",
    ]);
    assert.equal(options.length, 2);
  });
});
