import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { retireLegacyShimAgent, SHIM_AGENT_LABEL } from "../../lib/harnesses/claude-desktop/platform.mjs";
import {
  migrateDesktopShimAgentOnUpgrade,
  restartClaudeDesktopShimOnUpgrade,
} from "../../lib/harnesses/claude-desktop/upgrade-migrations.mjs";
import { claudeStatusLineCommand } from "../../lib/harnesses/claude/statusline.mjs";
import { migrateClaudeStatusLinePathOnUpgrade } from "../../lib/harnesses/claude/upgrade-migrations.mjs";
import { withTempHome } from "../helpers.mjs";

async function seedMigratedHome(home) {
  await mkdir(path.join(home, ".nexus/cli"), { recursive: true });
}

async function writeClaudeSettings(home, settings) {
  const file = path.join(home, ".claude/settings.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

const LEGACY_LABEL = "ai.fireworks.fireconnect.claude-desktop-shim";

const plist = (home, label) => `<plist><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/node</string>
    <string>${home}/.fireconnect/cli/packages/setup-cli/lib/harnesses/claude-desktop/shim.mjs</string>
  </array>
  <key>StandardOutPath</key><string>${home}/.fireconnect/claude-desktop/shim.log</string>
</dict></plist>
`;

describe("migrateClaudeStatusLinePathOnUpgrade", () => {
  it("refreshes a managed status line left under ~/.fireconnect", async () => {
    await withTempHome("statusline-path-", async (home) => {
      const command = `/usr/bin/node ${home}/.fireconnect/cli/packages/setup-cli/bin/claude-statusline.mjs`;
      const file = await writeClaudeSettings(home, { theme: "dark", statusLine: { type: "command", command } });

      assert.equal(await migrateClaudeStatusLinePathOnUpgrade(home), true);
      const settings = JSON.parse(await readFile(file, "utf8"));
      assert.equal(settings.statusLine.command, claudeStatusLineCommand());
      assert.equal(settings.theme, "dark");
      assert.equal(await migrateClaudeStatusLinePathOnUpgrade(home), false, "idempotent");
    });
  });

  it("leaves a user's own status line, or none, alone", async () => {
    await withTempHome("statusline-path-user-", async (home) => {
      const own = { statusLine: { type: "command", command: `${home}/.fireconnect/my-line.sh` } };
      const file = await writeClaudeSettings(home, own);
      assert.equal(await migrateClaudeStatusLinePathOnUpgrade(home), false);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), own);

      await writeClaudeSettings(home, { theme: "dark" });
      assert.equal(await migrateClaudeStatusLinePathOnUpgrade(home), false);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { theme: "dark" });
    });
  });
});

describe("migrateDesktopShimAgentOnUpgrade", () => {
  const agents = (home) => path.join(home, "Library/LaunchAgents");

  async function writePlist(home, label) {
    const file = path.join(agents(home), `${label}.plist`);
    await mkdir(agents(home), { recursive: true });
    await writeFile(file, plist(home, label));
    return file;
  }

  function recorder() {
    const calls = [];
    return {
      calls,
      start: async (file, options) => { calls.push(["start", path.basename(file), options.label]); },
      stop: async (options) => { calls.push(["stop", options.label]); },
    };
  }

  it("moves the pre-rename agent to the Nexus label and ~/.nexus paths", async () => {
    await withTempHome("shim-label-", async (home) => {
      await seedMigratedHome(home);
      const legacyPath = await writePlist(home, LEGACY_LABEL);
      const { calls, start, stop } = recorder();

      assert.equal(await migrateDesktopShimAgentOnUpgrade(home, { platform: "darwin", start, stop }), true);
      const next = await readFile(path.join(agents(home), `${SHIM_AGENT_LABEL}.plist`), "utf8");
      assert.ok(next.includes(`<string>${SHIM_AGENT_LABEL}</string>`));
      assert.ok(next.includes(`${home}/.nexus/cli/packages/setup-cli/lib/harnesses/claude-desktop/shim.mjs`));
      assert.ok(next.includes(`${home}/.nexus/claude-desktop/shim.log`));
      assert.ok(!next.includes("/.fireconnect/") && !next.includes(LEGACY_LABEL));
      await assert.rejects(readFile(legacyPath, "utf8"), { code: "ENOENT" });
      assert.deepEqual(calls, [
        ["stop", LEGACY_LABEL],
        ["start", `${SHIM_AGENT_LABEL}.plist`, SHIM_AGENT_LABEL],
      ]);
      assert.equal(await migrateDesktopShimAgentOnUpgrade(home, { platform: "darwin", start, stop }), false, "idempotent");
    });
  });

  it("keeps the legacy plist when the new agent fails to start, and retries", async () => {
    await withTempHome("shim-label-retry-", async (home) => {
      await seedMigratedHome(home);
      const legacyPath = await writePlist(home, LEGACY_LABEL);
      const { calls, start, stop } = recorder();
      const failingStart = async () => { throw new Error("bootstrap failed"); };

      await assert.rejects(migrateDesktopShimAgentOnUpgrade(home, { platform: "darwin", start: failingStart, stop }));
      assert.ok(await readFile(legacyPath, "utf8"), "legacy plist kept for the retry");

      assert.equal(await migrateDesktopShimAgentOnUpgrade(home, { platform: "darwin", start, stop }), true);
      await assert.rejects(readFile(legacyPath, "utf8"), { code: "ENOENT" });
      assert.deepEqual(calls.at(-1), ["start", `${SHIM_AGENT_LABEL}.plist`, SHIM_AGENT_LABEL]);
    });
  });

  it("retireLegacyShimAgent unloads the pre-rename job and deletes its plist", async () => {
    await withTempHome("shim-retire-", async (home) => {
      const legacyPath = await writePlist(home, LEGACY_LABEL);
      const ran = [];
      const prev = process.env.NEXUS_TEST;
      delete process.env.NEXUS_TEST;
      try {
        await retireLegacyShimAgent(home, { allowSystemChanges: true, platform: "darwin", run: async (cmd, args) => { ran.push(args); } });
      } finally {
        process.env.NEXUS_TEST = prev;
      }
      assert.equal(ran.length, 1);
      assert.equal(ran[0][0], "bootout");
      assert.match(ran[0][1], new RegExp(`/${LEGACY_LABEL.replaceAll(".", "\\.")}$`));
      await assert.rejects(readFile(legacyPath, "utf8"), { code: "ENOENT" });
    });
  });

  it("only repoints paths when the agent already has the Nexus label", async () => {
    await withTempHome("shim-paths-", async (home) => {
      await seedMigratedHome(home);
      await writePlist(home, SHIM_AGENT_LABEL);
      const { calls, start, stop } = recorder();

      assert.equal(await migrateDesktopShimAgentOnUpgrade(home, { platform: "darwin", start, stop }), true);
      assert.deepEqual(calls, [["start", `${SHIM_AGENT_LABEL}.plist`, SHIM_AGENT_LABEL]]);
    });
  });

  it("does nothing without an agent or off macOS", async () => {
    await withTempHome("shim-skip-", async (home) => {
      const { calls, start, stop } = recorder();
      assert.equal(await migrateDesktopShimAgentOnUpgrade(home, { platform: "darwin", start, stop }), false);
      await writePlist(home, LEGACY_LABEL);
      assert.equal(await migrateDesktopShimAgentOnUpgrade(home, { platform: "linux", start, stop }), false);
      assert.deepEqual(calls, []);
    });
  });
});

describe("restartClaudeDesktopShimOnUpgrade", () => {
  it("restarts the existing shim service so upgraded code takes effect", async () => {
    await withTempHome("shim-restart-", async (home) => {
      const savedTest = process.env.NEXUS_TEST;
      delete process.env.NEXUS_TEST;
      try {
        const { shimServicePath } = await import("../../lib/harnesses/claude-desktop/profile-lane.mjs");
        const dataDir = path.join(home, ".nexus", "claude-desktop");
        await mkdir(path.dirname(shimServicePath(home)), { recursive: true });
        await mkdir(dataDir, { recursive: true });
        await writeFile(shimServicePath(home), "[Unit]\n");
        await writeFile(path.join(dataDir, "profile-state.json"), JSON.stringify({ profileId: "test" }));
        const calls = [];
        const start = async (file, options) => { calls.push([path.basename(file), options.label]); };
        assert.equal(await restartClaudeDesktopShimOnUpgrade(home, { platform: "linux", start }), true);
        assert.equal(calls.length, 1);
        // No service file: nothing to restart.
        await rm(shimServicePath(home), { force: true });
        assert.equal(await restartClaudeDesktopShimOnUpgrade(home, { platform: "linux", start }), false);
      } finally {
        if (savedTest === undefined) delete process.env.NEXUS_TEST;
        else process.env.NEXUS_TEST = savedTest;
      }
    });
  });
});
