import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock } from "node:test";

import { printHelp } from "../../../lib/cli/commands/global.mjs";
import { WORKSPACE_NOTES } from "../../../lib/harnesses/claude-desktop/core.mjs";

const README = new URL("../../../../../README.md", import.meta.url);

function captureHelp(topic) {
  const log = mock.method(console, "log", () => {});
  try {
    printHelp(topic);
    return log.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
  } finally {
    log.mock.restore();
  }
}

test("claude-desktop help lists every workspace note", () => {
  const help = captureHelp("claude-desktop");
  assert.match(help, /What stays with your claude\.ai subscription:/);
  for (const note of WORKSPACE_NOTES) assert.ok(help.includes(note), `help is missing: ${note}`);
});

test("README mirrors every workspace note verbatim", async () => {
  const readme = await readFile(README, "utf8");
  for (const note of WORKSPACE_NOTES) assert.ok(readme.includes(note), `README is missing: ${note}`);
});
