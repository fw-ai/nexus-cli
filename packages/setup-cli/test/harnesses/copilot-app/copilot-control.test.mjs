import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { COPILOT_PROCESS_SPEC } from "../../../lib/harnesses/copilot-app/sqlite.mjs";

/** POSIX ERE check (same dialect as `pgrep -f`). Node RegExp lacks `[[:space:]]`. */
function matches(pattern, cmdline) {
  return spawnSync("grep", ["-E", pattern], { input: cmdline, encoding: "utf8" }).status === 0;
}

/** tasklist lists the image name in column 0, so the guard anchors there. */
function matchesImage(image, line) {
  return new RegExp(`^\\s*${image}\\b`, "im").test(line);
}

describe("copilot quit guard targets the desktop app, not the CLI", () => {
  const { darwinPattern, linuxPattern, windowsImage } = COPILOT_PROCESS_SPEC;

  it("matches the macOS app bundle executable", () => {
    assert.ok(matches(darwinPattern, "/Applications/GitHub Copilot.app/Contents/MacOS/github"));
  });

  it("does not match the Copilot CLI on macOS", () => {
    // The harness configures this CLI via providers.json; it never opens
    // data.db, so a running session must not trigger the quit guard.
    assert.ok(!matches(darwinPattern, "/opt/homebrew/bin/copilot --model fireworks/glm-latest"));
    assert.ok(!matches(darwinPattern, "node /usr/local/lib/node_modules/@github/copilot/index.js"));
  });

  it("matches the desktop binary on Linux, in either layout", () => {
    // The app ships only `github-copilot-app` and `GitHub Copilot.desktop` as
    // packaging hints, so cover both a kebab-case binary and the macOS-style
    // exec name inside a "GitHub Copilot/" install dir.
    assert.ok(matches(linuxPattern, "/opt/github-copilot/github-copilot"));
    assert.ok(matches(linuxPattern, "/usr/bin/github-copilot-app --no-sandbox"));
    assert.ok(matches(linuxPattern, "/opt/GitHub Copilot/github"));
  });

  it("matches the official Linux .deb, which runs as `github`", () => {
    assert.ok(matches(linuxPattern, "github"));
    assert.ok(matches(linuxPattern, "github copilot://open"));
    assert.ok(matches(linuxPattern, "/usr/bin/github"));
    assert.ok(matches(linuxPattern, "/tmp/.mount_GitHubX/usr/bin/github --no-sandbox"));
  });

  it("does not match other commands that mention github", () => {
    assert.ok(!matches(linuxPattern, "bash -c cd /home/u/src/github && make"));
    assert.ok(!matches(linuxPattern, "git clone https://github.com/example/repo"));
    assert.ok(!matches(linuxPattern, "/usr/bin/github-desktop"));
    assert.ok(!matches(linuxPattern, "gh pr view"));
  });

  it("does not match the Copilot CLI on Linux", () => {
    // A bare `[/]copilot` pattern matched these and blocked on/off waiting
    // for a quit that was never needed.
    assert.ok(!matches(linuxPattern, "/usr/local/bin/copilot"));
    assert.ok(!matches(linuxPattern, "/usr/local/bin/copilot --model fireworks/kimi-latest"));
    assert.ok(!matches(linuxPattern, "/home/u/.npm-global/bin/copilot -p hello"));
  });

  it("matches the desktop images on Windows, but never the CLI", () => {
    // tasklist gives image names only, so every plausible desktop executable
    // is enumerated: the app itself and copilotd.exe (the daemon named in the
    // app's own PowerShell strings).
    assert.ok(matchesImage(windowsImage, "github-copilot.exe                 1234 Console"));
    assert.ok(matchesImage(windowsImage, "github-copilot-app.exe             1234 Console"));
    assert.ok(matchesImage(windowsImage, "GitHub Copilot.exe                 1234 Console"));
    assert.ok(matchesImage(windowsImage, "copilotd.exe                       1234 Services"));
    // The CLI. `copilotd` must not be confused with `copilot`.
    assert.ok(!matchesImage(windowsImage, "copilot.exe                        4321 Console"));
    assert.ok(!matchesImage(windowsImage, "node.exe                           4321 Console"));
  });
});
