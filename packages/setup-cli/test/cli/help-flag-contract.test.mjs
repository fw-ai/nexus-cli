import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { printHelp } from "../../lib/cli/commands/global.mjs";
import { HARNESSES } from "../../lib/harness/id.mjs";
import { getHarness } from "../../lib/harness/registry.mjs";

function helpTextFor(harnessId) {
  const original = console.log;
  let text = "";
  console.log = (line = "") => { text += `${line}\n`; };
  try {
    printHelp(harnessId);
  } finally {
    console.log = original;
  }
  return text;
}

const advertises = (help, flag) => new RegExp(`^\\s+--${flag}\\b`, "m").test(help);

describe("harness help flag contract", () => {
  // Provider keys for Nexus Auto belong to `nexus auto`, so no harness help
  // offers them, and `nexus auto --help` does.
  it("advertises provider-key flags on nexus auto only", () => {
    for (const harnessId of HARNESSES) {
      const help = helpTextFor(harnessId);
      assert.equal(advertises(help, "routing-preference"), false, `${harnessId}: --routing-preference is retired`);
      assert.equal(advertises(help, "anthropic-api-key"), false, `${harnessId}: --anthropic-api-key belongs to nexus auto`);
      assert.equal(advertises(help, "openai-api-key"), false, `${harnessId}: --openai-api-key belongs to nexus auto`);
    }
    const autoHelp = helpTextFor("auto");
    assert.equal(advertises(autoHelp, "anthropic-api-key"), true);
    assert.equal(advertises(autoHelp, "openai-api-key"), true);
    assert.equal(advertises(autoHelp, "unset"), true);
  });

  it("advertises --azure only on harnesses with Foundry support", () => {
    for (const harnessId of HARNESSES) {
      assert.equal(
        advertises(helpTextFor(harnessId), "azure"),
        Boolean(getHarness(harnessId).azure),
        `${harnessId}: --azure help matches Foundry support`,
      );
    }
  });

  it("advertises no provider-key flags on Codex, which uses its own sign-in", () => {
    const help = helpTextFor("codex");
    assert.equal(getHarness("codex").firerouter.byok, "none");
    assert.equal(advertises(help, "anthropic-api-key"), false);
    assert.equal(advertises(help, "openai-api-key"), false);
  });
});
