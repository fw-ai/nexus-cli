import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fireworksModelPickerDescription, fireworksModelPickerName } from "../../lib/harnesses/claude/picker-labels.mjs";
import { buildCodexAutoCatalogEntry, buildCodexFirerouterCatalogEntry } from "../../lib/harnesses/codex/catalog.mjs";
import { SMART_ROUTER_NOTES } from "../../lib/fireworks/model-list.mjs";
import { isAutoModelId } from "../../lib/fireworks/model-id.mjs";

const ROUTERS = [
  "auto",
  "auto-instant",
  "firerouter",
  "firerouter/opus",
  "firerouter/sol",
  "firerouter/kimi-k3",
  "firerouter/opus/glm-5p3",
  "firerouter/auto",
];

function codexRow(id) {
  return isAutoModelId(id) ? buildCodexAutoCatalogEntry(id) : buildCodexFirerouterCatalogEntry(id);
}

describe("router descriptions", () => {
  it("match between the Claude Code picker, the Codex picker, and `model list`", () => {
    for (const id of ROUTERS) {
      const description = fireworksModelPickerDescription(id);
      assert.equal(codexRow(id).description, description, id);
      if (SMART_ROUTER_NOTES[id]) {
        assert.equal(SMART_ROUTER_NOTES[id], description, id);
      }
    }
  });

  it("names GPT families the same way in both pickers", () => {
    assert.equal(fireworksModelPickerName("firerouter/sol"), "FireRouter · Sol");
    assert.equal(codexRow("firerouter/sol").display_name, "FireRouter · Sol");
    assert.equal(fireworksModelPickerName("firerouter/astra"), "FireRouter · Astra");
  });
});
