import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CLAUDE_CODE_MODEL_PICKER_MIN_VERSION,
  claudeCodeModelPickerNote,
  installedClaudeCodeVersion,
  parseClaudeCodeVersion,
} from "../../../lib/harnesses/claude/claude-code-version.mjs";
import { printClaudePickerSummary } from "../../../lib/harnesses/claude/onboarding.mjs";
import { mockServerlessModel, runFireconnect, seedServerlessCatalogCache } from "../../helpers.mjs";

const POSIX_ONLY = { skip: process.platform === "win32" };

async function fakeClaudeOnPath(stdout, exitCode = 0) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nx-fake-claude-"));
  const bin = path.join(dir, "claude");
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nexit ${exitCode}\n`);
  await chmod(bin, 0o755);
  return dir;
}

describe("Claude Code version check", () => {
  it("parses the version from `claude --version`", () => {
    assert.equal(parseClaudeCodeVersion("2.1.227 (Claude Code)\n"), "2.1.227");
    assert.equal(parseClaudeCodeVersion("warning: something\n2.1.227 (Claude Code)\n"), "2.1.227");
    assert.equal(parseClaudeCodeVersion("not a version"), "");
    assert.equal(parseClaudeCodeVersion(undefined), "");
  });

  it("notes only releases older than the first one that reads modelPicker", () => {
    assert.match(claudeCodeModelPickerNote("2.1.227"), /Claude Code 2\.1\.227 can't show the Fireworks catalog in \/model/);
    assert.match(claudeCodeModelPickerNote("2.1.241"), /claude update/);
    assert.equal(claudeCodeModelPickerNote(CLAUDE_CODE_MODEL_PICKER_MIN_VERSION), "");
    assert.equal(claudeCodeModelPickerNote("2.1.307"), "");
    assert.equal(claudeCodeModelPickerNote("2.2.0"), "");
    assert.equal(claudeCodeModelPickerNote("3.0.0"), "");
    assert.equal(claudeCodeModelPickerNote(""), "", "an unknown version prints nothing");
  });

  it("reads the version from the claude on PATH", POSIX_ONLY, async () => {
    const dir = await fakeClaudeOnPath("2.1.227 (Claude Code)");
    assert.equal(installedClaudeCodeVersion({ env: { PATH: dir, NEXUS_TEST: "" } }), "2.1.227");
  });

  it("returns empty when claude is missing or fails", POSIX_ONLY, async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "nx-no-claude-"));
    assert.equal(installedClaudeCodeVersion({ env: { PATH: empty, NEXUS_TEST: "" } }), "");
    const failing = await fakeClaudeOnPath("2.1.227 (Claude Code)", 1);
    assert.equal(installedClaudeCodeVersion({ env: { PATH: failing, NEXUS_TEST: "" } }), "");
  });

  it("the picker summary says when the catalog can't show", () => {
    let text = "";
    printClaudePickerSummary({ catalogShown: false }, { write: (chunk) => { text += chunk; return true; } });
    assert.match(text, /Fireworks catalog.*needs a newer Claude Code/);
    assert.doesNotMatch(text, /appended in \/model/);
  });

  it("`claude on` tells an old Claude Code to update, and stays quiet on a current one", async () => {
    const run = async (version) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "nx-claude-version-"));
      seedServerlessCatalogCache(home, [mockServerlessModel({
        name: "accounts/fireworks/models/glm-5p3",
        aliases: ["accounts/fireworks/routers/glm-latest"],
      })]);
      const result = await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        NEXUS_TEST_CLAUDE_VERSION: version,
      });
      assert.equal(result.code, 0, result.stderr);
      return result.stdout;
    };
    const old = await run("2.1.227 (Claude Code)");
    assert.match(old, /Fireworks catalog.*needs a newer Claude Code/);
    assert.match(old, /Claude Code 2\.1\.227 can't show the Fireworks catalog in \/model[\s\S]*claude update/);
    const current = await run("2.1.307 (Claude Code)");
    assert.match(current, /Fireworks catalog.*appended in \/model/);
    assert.doesNotMatch(current, /can't show the Fireworks catalog/);
  });
});
