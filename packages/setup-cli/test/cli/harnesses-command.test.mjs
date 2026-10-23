import assert from "node:assert/strict";
import process from "node:process";
import { after, before, describe, it, mock } from "node:test";

import { runHarnessesCommand } from "../../lib/cli/commands/harnesses.mjs";
import { setHarnessEnabled } from "../../lib/config/global-config.mjs";
import { HARNESS_COMMANDS, HARNESSES, HARNESS_ALIASES } from "../../lib/harness/id.mjs";
import { withTempHome } from "../helpers.mjs";

// Cursor and VS Code resolve their config dirs from these before HOME.
const CONFIG_DIR_VARS = ["XDG_CONFIG_HOME", "APPDATA"];

async function captureHarnessesOutput(home, { json = false } = {}) {
  const log = mock.method(console, "log", () => {});
  try {
    await runHarnessesCommand({ home, json });
    return log.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
  } finally {
    log.mock.restore();
  }
}

describe("fireconnect harnesses", () => {
  const saved = {};
  before(() => {
    for (const name of CONFIG_DIR_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  after(() => {
    for (const name of CONFIG_DIR_VARS) {
      if (saved[name] !== undefined) process.env[name] = saved[name];
    }
  });

  it("lists every registered harness and alias exactly once", () => {
    const commands = HARNESS_COMMANDS.map((row) => row.command);
    assert.deepEqual([...commands].sort(), [...HARNESSES, ...Object.keys(HARNESS_ALIASES)].sort());
  });

  it("reports nothing connected on a fresh machine", async () => {
    await withTempHome("harnesses-fresh", async (home) => {
      const { harnesses } = JSON.parse(await captureHarnessesOutput(home, { json: true }));
      assert.equal(harnesses.length, HARNESS_COMMANDS.length);
      assert.ok(harnesses.every((row) => row.connected === false));
    });
  });

  it("still works but says it's deprecated, on stderr only", async () => {
    await withTempHome("harnesses-deprecated", async (home) => {
      const write = mock.method(process.stderr, "write", () => true);
      try {
        const { harnesses } = JSON.parse(await captureHarnessesOutput(home, { json: true }));
        assert.equal(harnesses.length, HARNESS_COMMANDS.length);
        assert.ok(write.mock.calls.some((call) => String(call.arguments[0]).includes("`nexus status`")));
      } finally {
        write.mock.restore();
      }
    });
  });

  it("marks a connected harness on and maps aliases to their canonical id", async () => {
    await withTempHome("harnesses-on", async (home) => {
      await setHarnessEnabled(home, "claude-desktop", true);
      const { harnesses } = JSON.parse(await captureHarnessesOutput(home, { json: true }));
      assert.deepEqual(harnesses.filter((row) => row.connected).map((row) => row.command), ["claude-desktop"]);
      assert.equal(harnesses.find((row) => row.command === "chatgpt").id, "codex");
      assert.match(await captureHarnessesOutput(home), /claude-desktop\s+Claude Desktop \(Fireworks inference\)\s+on/);
    });
  });
});
