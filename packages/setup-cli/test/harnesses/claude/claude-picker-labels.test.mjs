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
      "Smart routing: automatically picks the best model for the task.",
    );
    assert.equal(
      fireworksModelPickerDescription("firerouter"),
      "Smart routing: automatically picks the best model for the task.",
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

  it("labels a leftover FireRouter id like auto, which is how the gateway serves it", () => {
    for (const id of ["firerouter", "firerouter/astra", "firerouter/claude-opus-5/kimi-k3"]) {
      assert.equal(fireworksModelPickerName(id), "Auto", id);
      assert.equal(fireworksModelPickerDescription(id), "Smart routing: automatically picks the best model for the task.", id);
    }
  });
});
