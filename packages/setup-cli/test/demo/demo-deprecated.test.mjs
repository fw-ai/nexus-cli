import test from "node:test";
import assert from "node:assert/strict";
import { runCli, withTempHome } from "../helpers.mjs";

// Top-level `nexus demo` is deprecated. It must NOT run the race — just
// print a deprecation notice pointing at `nexus claude demo` and exit 0.
test("top-level `fireconnect demo` prints a deprecation notice and does not run", async () => {
  await withTempHome("demo-deprecated-", async (home) => {
    const r = await runCli(["demo"], { home });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    // The deprecation notice (warn → stderr) points users at the replacement.
    assert.match(r.stderr, /`nexus demo` is deprecated/i);
    assert.match(r.stderr, /`nexus claude demo`/);
    // The stdout pointer restates the replacement command.
    assert.match(r.stdout, /`nexus claude demo`/);
    // The race must not have executed — no result/plan payload, no model pairing.
    assert.doesNotMatch(r.stdout, /speedRatio|costSavedFraction|"promptTitle"/);
    assert.doesNotMatch(r.stderr, /speedRatio|costSavedFraction|"promptTitle"/);
  });
});
