import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFireconnect } from "./helpers.mjs";

describe("runFireconnect HOME isolation", () => {
  it("never runs the CLI against the inherited HOME when the caller passes none", async () => {
    // Stand in for a developer's home with a pre-rename install: any command
    // run there migrates ~/.fireconnect to ~/.nexus and rewrites launchers.
    const devHome = await mkdtemp(path.join(os.tmpdir(), "fc-dev-home-"));
    const savedHome = process.env.HOME;
    try {
      await mkdir(path.join(devHome, ".fireconnect", "claude"), { recursive: true });
      await writeFile(path.join(devHome, ".fireconnect", "config.json"), "{}\n");
      process.env.HOME = devHome;

      const { code } = await runFireconnect(["help"], { NO_COLOR: "1" });
      assert.equal(code, 0);

      const legacy = await lstat(path.join(devHome, ".fireconnect"));
      assert.ok(legacy.isDirectory() && !legacy.isSymbolicLink(), "~/.fireconnect was migrated");
      assert.equal(await readFile(path.join(devHome, ".fireconnect", "config.json"), "utf8"), "{}\n");
      await assert.rejects(lstat(path.join(devHome, ".nexus")), /ENOENT/);
    } finally {
      process.env.HOME = savedHome;
      await rm(devHome, { recursive: true, force: true });
    }
  });
});
