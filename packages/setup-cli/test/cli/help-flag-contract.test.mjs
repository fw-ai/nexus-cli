import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { printHelp } from "../../lib/cli/commands/global.mjs";
import { HARNESS, HARNESSES } from "../../lib/harness/id.mjs";
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
  // `<harness> help` must not offer a flag that harness.mjs rejects on `on`.
  // The BYOK flags only ever served FireRouter routes, which are retired, so
  // no harness help lists them — except Claude's `--openai-api-key`, which
  // `claude on` still accepts to store the key.
  it("advertises BYOK flags only where `on` accepts them", () => {
    for (const harnessId of HARNESSES) {
      const help = helpTextFor(harnessId);
      assert.equal(advertises(help, "routing-preference"), false, `${harnessId}: --routing-preference is retired`);
      assert.equal(
        advertises(help, "anthropic-api-key"),
        false,
        `${harnessId}: --anthropic-api-key is retired with FireRouter`,
      );
      assert.equal(
        advertises(help, "openai-api-key"),
        harnessId === HARNESS.CLAUDE,
        `${harnessId}: --openai-api-key is only accepted by claude on`,
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
