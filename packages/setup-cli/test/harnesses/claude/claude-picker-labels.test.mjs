import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fireworksModelPickerDescription,
  fireworksModelPickerName,
} from "../../../lib/harnesses/claude/picker-labels.mjs";

describe("Claude picker labels", () => {
  it("uses Claude-style per Mtok pricing in descriptions", () => {
    assert.equal(
      fireworksModelPickerDescription("auto"),
      "Routes each user turn across Fireworks open models.",
    );
    assert.equal(
      fireworksModelPickerDescription("firerouter"),
      "Routes each user turn between open models and the closed models you have access to.",
    );
    const flash = fireworksModelPickerDescription("deepseek-v4-flash");
    assert.equal(flash, "Fireworks serverless · $0.22/$0.66 per Mtok");
    assert.doesNotMatch(flash, /cached in|Rates:/);

    const fast = fireworksModelPickerDescription("glm-5p2-fast");
    assert.equal(fast, "Fireworks serverless · Fast tier · $2.1/$6.6 per Mtok");
  });

  it("still resolves display names from specs", () => {
    assert.match(fireworksModelPickerName("glm-latest"), /GLM/);
  });

  it("labels firerouter compounds with their pinned members", () => {
    assert.equal(fireworksModelPickerName("firerouter"), "FireRouter");
    assert.equal(fireworksModelPickerName("firerouter/astra"), "FireRouter · Astra");
    assert.equal(
      fireworksModelPickerName("firerouter/claude-opus-5/kimi-k3"),
      "FireRouter · Claude Opus 5 · Kimi K3",
    );
    assert.equal(
      fireworksModelPickerDescription("firerouter/astra"),
      "Routes each user turn between this closed model and Fireworks open models.",
    );
    assert.equal(
      fireworksModelPickerDescription("firerouter/opus"),
      "Routes each user turn between this closed model and Fireworks open models.",
    );
  });
});
