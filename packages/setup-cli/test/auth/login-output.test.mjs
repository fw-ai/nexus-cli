import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { printSuccessBlock } from "../../lib/auth/login/output.mjs";
import { HARNESS_COMMANDS } from "../../lib/harness/id.mjs";

function captureSuccessBlock(options) {
  const log = mock.method(console, "log", () => {});
  try {
    printSuccessBlock({ email: "user@example.com", accountId: "example-account" }, [], options);
    return log.mock.calls.map((call) => call.arguments.join(" "));
  } finally {
    log.mock.restore();
  }
}

describe("printSuccessBlock", () => {
  it("suggests each featured harness by name", () => {
    const lines = captureSuccessBlock();
    for (const { command, name } of HARNESS_COMMANDS.filter((row) => row.featured)) {
      assert.ok(
        lines.some((line) => line.includes(`nexus ${command} `) && line.endsWith(name)),
        `expected a next step for ${command}`,
      );
    }
  });

  it("points at the full harness list", () => {
    assert.ok(captureSuccessBlock().some((line) => line.includes("nexus status")));
  });

  it("omits next steps when the caller already chose a harness", () => {
    const lines = captureSuccessBlock({ nextHint: false });
    assert.ok(!lines.some((line) => line.includes("Next") || line.includes("nexus status")));
  });
});
