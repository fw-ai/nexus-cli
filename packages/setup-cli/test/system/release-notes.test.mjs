import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  formatReleaseNotes,
  printReleaseNotesAfterUpgrade,
  readReleaseNotes,
  RELEASE_NOTES_STATE_RELATIVE_PATH,
  releaseNotesForRange,
} from "../../lib/system/release-notes.mjs";
import { runCli } from "../helpers.mjs";

function captureOutput() {
  let text = "";
  return {
    output: {
      write(chunk) {
        text += chunk;
      },
    },
    text() {
      return text;
    },
  };
}

describe("release notes", () => {
  it("formats the approved v0.9 user-facing summary", async () => {
    const releases = await readReleaseNotes();
    const release = releases.find((candidate) => candidate.version === "0.9.0");
    assert.ok(release);

    const formatted = formatReleaseNotes(release);
    assert.match(formatted, /Fireworks-hosted WebSearch MCP for eligible accounts/);
    assert.match(formatted, /Fireworks Responses API/);
    assert.match(formatted, /Kimi models accept image inputs/);
    assert.match(formatted, /GLM models remain text-only/);
    assert.match(formatted, /coding-focused catalog/);
    assert.match(formatted, /custom enterprise SSO support/);
    assert.doesNotMatch(formatted, /when Claude routing is enabled/);
    assert.doesNotMatch(formatted, /FirePass|BYOK|Legacy --router|all harnesses/i);
  });

  it("formats the v0.9.1 user-facing summary", async () => {
    const releases = await readReleaseNotes();
    const release = releases.find((candidate) => candidate.version === "0.9.1");
    assert.ok(release);

    const formatted = formatReleaseNotes(release);
    assert.match(formatted, /Keep Claude Code connected/);
    assert.match(formatted, /upgrade in place/);
    assert.match(formatted, /Claude model preferences/);
    assert.match(formatted, /baked API keys/);
    assert.doesNotMatch(formatted, /Bugbot|argv|fetchFailed|patchUpdateCache|fireconnect status|libsecret/i);
  });

  it("formats the v0.9.8 user-facing summary", async () => {
    const releases = await readReleaseNotes();
    const release = releases.find((candidate) => candidate.version === "0.9.8");
    assert.ok(release);

    const formatted = formatReleaseNotes(release);
    assert.match(formatted, /What's new in Nexus v0\.9\.8/);
    assert.match(formatted, /`fireconnect claude-desktop on`/);
    assert.match(formatted, /`fireconnect claude-desktop mcp sync`/);
    assert.match(formatted, /--subagent deepseek-flash-latest/);
    assert.match(formatted, /`fireconnect configure --openai-api-key sk-\.\.\.`/);
    assert.match(formatted, /Fixed: `fireconnect claude --model <id>` could report success without adding the model/);
    assert.match(formatted, /New: `fireconnect models`, a shortcut for `fireconnect model list`/);
    assert.match(formatted, /`fireconnect codex on` or `fireconnect deepseek on`/);
    assert.doesNotMatch(formatted, /\u2014/);
    assert.doesNotMatch(formatted, /safeguards|AUTO_MODE_SERVER|launchd|shim|Bugbot|Lean/i);
  });

  it("formats the v0.9.9 user-facing summary", async () => {
    const releases = await readReleaseNotes();
    const release = releases.find((candidate) => candidate.version === "0.9.9");
    assert.ok(release);

    const formatted = formatReleaseNotes(release);
    assert.match(formatted, /What's new in Nexus v0\.9\.9/);
    assert.match(formatted, /Codex starts on FireRouter/);
    assert.match(formatted, /MCP servers and ChatGPT app connectors work in Codex/);
    assert.match(formatted, /Rotate your Fireworks key without breaking a harness/);
    assert.doesNotMatch(formatted, /claude live|on --model <id>|Code tab/);
    assert.match(formatted, /Claude Code no longer takes `--anthropic-api-key`/);
    assert.match(formatted, /`fireconnect configure --unset openai-api-key` and `--unset anthropic-api-key`/);
    assert.match(formatted, /`fireconnect configure --provider fireworks`/);
    assert.match(formatted, /OpenCode v2 lists your Fireworks models/);
    assert.match(formatted, /OpenCode's `\/models` no longer lists routers like `glm-latest` twice/);
    assert.doesNotMatch(formatted, /\u2014/);
    assert.doesNotMatch(formatted, /\b(supports_search_tool|requires_openai_auth|launchd|shim|plist|standalone|lsof|Bugbot|Lean)\b/i);
  });

  it("formats the v0.10.0 user-facing summary", async () => {
    const releases = await readReleaseNotes();
    const release = releases.find((candidate) => candidate.version === "0.10.0");
    assert.ok(release);

    const formatted = formatReleaseNotes(release);
    assert.match(formatted, /What's new in Nexus v0\.10\.0/);
    assert.match(formatted, /FireConnect is now Nexus/);
    assert.match(formatted, /Environment variables are now `NEXUS_\*` \(`FIRECONNECT_\*` still works\)/);
    assert.match(formatted, /FireRouter is retired/);
    assert.match(formatted, /FireRouter routes are no longer supported\. Use `--model auto` instead/);
    assert.match(formatted, /`nexus auto --providers fireworks`/);
    assert.match(formatted, /`nexus auto --reset` restores the default/);
    assert.match(formatted, /Claude Desktop works on Linux/);
    // Keep the notes simple: no placeholder harness commands.
    assert.doesNotMatch(formatted, /<harness>/);
    assert.doesNotMatch(formatted, /\u2014/);
  });

  it("selects releases newer than the installed version", () => {
    const releases = [
      { version: "0.8.0", highlights: [] },
      { version: "0.9.0", highlights: [] },
      { version: "0.10.0", highlights: [] },
    ];
    assert.deepEqual(
      releaseNotesForRange(releases, "0.8.0", "0.9.0").map(({ version }) => version),
      ["0.9.0"],
    );
  });

  it("shows upgrade notes once and records a private marker", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-release-notes-"));
    const capture = captureOutput();

    assert.equal(await printReleaseNotesAfterUpgrade({
      home,
      fromVersion: "0.8.0",
      toVersion: "0.9.0",
      output: capture.output,
    }), true);
    assert.match(capture.text(), /What's new in Nexus v0\.9\.0/);

    const statePath = path.join(home, RELEASE_NOTES_STATE_RELATIVE_PATH);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.lastShownVersion, "0.9.0");
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);

    assert.equal(await printReleaseNotesAfterUpgrade({
      home,
      fromVersion: "0.8.0",
      toVersion: "0.9.0",
      output: capture.output,
    }), false);
    assert.equal(
      capture.text().match(/What's new in Nexus/g)?.length,
      1,
    );
  });

  it("does not show release notes from normal commands", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-release-notes-help-"));
    const result = await runCli(["help"], { home });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /What's new in Nexus/);
  });

  it("reads future notes from the checkout updated by upgrade", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-release-notes-upgrade-"));
    const installDir = await mkdtemp(path.join(os.tmpdir(), "fc-release-install-"));
    const catalogPath = path.join(
      installDir,
      "packages/setup-cli/lib/system/release-notes.json",
    );
    await mkdir(path.dirname(catalogPath), { recursive: true });
    await writeFile(catalogPath, JSON.stringify({
      releases: [{
        version: "0.10.0",
        highlights: ["Future release detail."],
      }],
    }));
    const capture = captureOutput();

    assert.equal(await printReleaseNotesAfterUpgrade({
      home,
      fromVersion: "0.9.0",
      toVersion: "0.10.0",
      installDir,
      output: capture.output,
    }), true);
    assert.match(capture.text(), /Future release detail/);
  });
});
