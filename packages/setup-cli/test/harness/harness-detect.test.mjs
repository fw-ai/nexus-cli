import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectInstalledHarnesses } from "../../lib/harness/detect.mjs";

describe("detectInstalledHarnesses", () => {
  it("returns nothing for an empty home", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-detect-empty-"));
    try {
      assert.deepEqual(detectInstalledHarnesses(home), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns nothing when home is blank", () => {
    assert.deepEqual(detectInstalledHarnesses(""), []);
  });

  it("detects harnesses from their config footprints", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-detect-"));
    try {
      await mkdir(path.join(home, ".claude"), { recursive: true });
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await mkdir(path.join(home, ".dsh"), { recursive: true });
      const detected = detectInstalledHarnesses(home);
      assert.ok(detected.includes("claude"));
      assert.ok(detected.includes("codex"));
      assert.ok(detected.includes("deepseek"));
      assert.ok(!detected.includes("pi"));
      assert.ok(!detected.includes("claude-desktop"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  for (const name of ["Claude", "Claude-3p"]) {
    it(`detects Claude Desktop from its ${name} data dir`, async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-detect-desktop-"));
      try {
        const dataDir = process.platform === "linux"
          ? path.join(home, ".config", name)
          : path.join(home, "Library", "Application Support", name);
        await mkdir(dataDir, { recursive: true });
        assert.ok(detectInstalledHarnesses(home).includes("claude-desktop"));
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});
