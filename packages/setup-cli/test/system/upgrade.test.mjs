import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { runUpgradeCommand } from "../../lib/cli/commands/global.mjs";
import { FIREWORKS_BASE_URL } from "../../lib/fireworks/model-id.mjs";
import {
  CLAUDE_OFF_UPGRADE_BEFORE_VERSION,
  CLAUDE_UPGRADE_PROMPT,
  claudeUpgradeState,
  needsClaudeOffBeforeUpgrade,
  runClaudeUpgradePreflight,
} from "../../lib/system/upgrade.mjs";
import { runUpgradeFinalize } from "../../lib/system/upgrade-finalize.mjs";
import { runCli, withTempHome } from "../helpers.mjs";

function managedClaudeEvidence() {
  return {
    settings: {
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
      },
    },
    backup: {
      snapshot: {
        existed: false,
        raw: "",
      },
    },
  };
}

function fakeGit({ head = "old", target = "new", events = [] } = {}) {
  return (_file, args) => {
    const command = args.slice(2);
    events.push(command.join(" "));
    if (command[0] === "rev-parse" && command[1] === "HEAD") {
      return `${head}\n`;
    }
    if (command[0] === "rev-parse" && command[1] === "FETCH_HEAD") {
      return `${target}\n`;
    }
    return "";
  };
}

function upgradeDependencies(overrides = {}) {
  return {
    home: "/tmp/fireconnect-upgrade-test",
    exists: () => true,
    // Pre-0.9 so Claude-off preflight still applies unless a test overrides.
    readVersion: async () => "0.8.0",
    finalize: async () => {},
    printNotes: async () => {},
    getClaudeAdapter: () => ({ id: "claude", off: async () => {} }),
    printBannerFn: () => {},
    infoFn: () => {},
    successFn: () => {},
    log: () => {},
    runtimeDepsPresent: () => true,
    dataDirBlocked: () => false,
    ...overrides,
  };
}

describe("needsClaudeOffBeforeUpgrade", () => {
  it(`requires Claude-off only for FireConnect before ${CLAUDE_OFF_UPGRADE_BEFORE_VERSION}`, () => {
    assert.equal(needsClaudeOffBeforeUpgrade(""), true);
    assert.equal(needsClaudeOffBeforeUpgrade("0.8.9"), true);
    assert.equal(needsClaudeOffBeforeUpgrade("v0.8.0"), true);
    assert.equal(needsClaudeOffBeforeUpgrade("0.9.0"), false);
    assert.equal(needsClaudeOffBeforeUpgrade("v0.9.0"), false);
    assert.equal(needsClaudeOffBeforeUpgrade("1.0.0"), false);
  });
});

describe("Claude upgrade state", () => {
  it("detects either the global flag or managed settings evidence", () => {
    assert.equal(claudeUpgradeState({ globalEnabled: true }).enabled, true);

    const managed = claudeUpgradeState(managedClaudeEvidence());
    assert.equal(managed.enabled, true);
    assert.equal(managed.globalEnabled, false);
    assert.equal(managed.managedSettings, true);
  });

  it("does not treat an unowned Fireworks URL as enabled", () => {
    const state = claudeUpgradeState({
      settings: {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        },
      },
    });
    assert.deepEqual(state, {
      enabled: false,
      globalEnabled: false,
      managedSettings: false,
    });
  });
});

describe("Claude upgrade preflight", () => {
  it("skips Claude-off entirely for FireConnect 0.9.0+", async () => {
    let offCalled = false;
    let inspected = false;
    const result = await runClaudeUpgradePreflight({
      home: "/tmp/home",
      installedVersion: "0.9.0",
      adapter: { off: async () => { offCalled = true; } },
      input: { isTTY: false },
      environment: {},
      inspect: async () => {
        inspected = true;
        return { enabled: true, globalEnabled: true, managedSettings: true };
      },
      prompt: async () => {
        throw new Error("must not prompt on 0.9.0+");
      },
    });
    assert.deepEqual(result, { proceed: true, restored: false });
    assert.equal(offCalled, false);
    assert.equal(inspected, false);
  });

  it("fails closed without a TTY and tells the user how to restore", async () => {
    let offCalled = false;
    await assert.rejects(
      runClaudeUpgradePreflight({
        home: "/tmp/home",
        adapter: { off: async () => { offCalled = true; } },
        input: { isTTY: false },
        environment: {},
        inspect: async () => ({ enabled: true, globalEnabled: true, managedSettings: false }),
      }),
      /Run `fireconnect claude off`, then retry `fireconnect upgrade`/,
    );
    assert.equal(offCalled, false);
  });

  it("automatically restores without a TTY when explicitly enabled", async () => {
    const events = [];
    let inspection = 0;
    const result = await runClaudeUpgradePreflight({
      home: "/tmp/home",
      adapter: {
        off: async () => {
          events.push("off");
        },
      },
      input: { isTTY: false },
      environment: { NEXUS_AUTO_OFF_CLAUDE: "1" },
      prompt: async () => {
        throw new Error("automatic restoration must not prompt");
      },
      inspect: async () => {
        inspection += 1;
        events.push(`inspect-${inspection}`);
        return inspection === 1
          ? { enabled: true, globalEnabled: true, managedSettings: true }
          : { enabled: false, globalEnabled: false, managedSettings: false };
      },
    });

    assert.deepEqual(result, { proceed: true, restored: true });
    assert.deepEqual(events, ["inspect-1", "off", "inspect-2"]);
  });

  it("uses the exact default-yes prompt and cancels without calling off", async () => {
    let offCalled = false;
    const result = await runClaudeUpgradePreflight({
      home: "/tmp/home",
      adapter: { off: async () => { offCalled = true; } },
      input: { isTTY: true },
      environment: {},
      inspect: async () => ({ enabled: true, globalEnabled: false, managedSettings: true }),
      prompt: async (question, options) => {
        assert.equal(question, CLAUDE_UPGRADE_PROMPT);
        assert.equal(options.defaultYes, true);
        return false;
      },
    });

    assert.deepEqual(result, { proceed: false, restored: false });
    assert.equal(offCalled, false);
  });

  it("calls the loaded adapter and verifies both evidence sources are clear", async () => {
    const events = [];
    let inspection = 0;
    const result = await runClaudeUpgradePreflight({
      home: "/tmp/home",
      adapter: {
        off: async (ctx) => {
          events.push("off");
          assert.equal(ctx.home, "/tmp/home");
        },
      },
      input: { isTTY: true },
      environment: {},
      prompt: async () => {
        events.push("prompt");
        return true;
      },
      inspect: async () => {
        inspection += 1;
        events.push(`inspect-${inspection}`);
        return inspection === 1
          ? { enabled: true, globalEnabled: true, managedSettings: true }
          : { enabled: false, globalEnabled: false, managedSettings: false };
      },
    });

    assert.deepEqual(result, { proceed: true, restored: true });
    assert.deepEqual(events, ["inspect-1", "prompt", "off", "inspect-2"]);
  });

  it("aborts when off leaves managed settings behind", async () => {
    let inspection = 0;
    await assert.rejects(
      runClaudeUpgradePreflight({
        home: "/tmp/home",
        adapter: { off: async () => {} },
        input: { isTTY: false },
        environment: { NEXUS_AUTO_OFF_CLAUDE: "1" },
        prompt: async () => {
          throw new Error("automatic restoration must not prompt");
        },
        inspect: async () => {
          inspection += 1;
          return inspection === 1
            ? { enabled: true, globalEnabled: true, managedSettings: true }
            : { enabled: true, globalEnabled: false, managedSettings: true };
        },
      }),
      /settings were not fully restored; upgrade cancelled/,
    );
  });
});

describe("upgrade with a foreign ~/.nexus", () => {
  it("stops before fetching, resetting, or claiming success", async () => {
    const events = [];
    let finalized = false;
    let succeeded = false;
    await assert.rejects(
      runUpgradeCommand(upgradeDependencies({
        execFile: fakeGit({ events }),
        dataDirBlocked: () => true,
        finalize: async () => {
          finalized = true;
        },
        successFn: () => {
          succeeded = true;
        },
      })),
      /Update stopped before changing anything: ~\/\.nexus belongs to another program.*Rename or remove ~\/\.nexus, then run the update again\./,
    );
    assert.deepEqual(events, [], "no git fetch or reset runs");
    assert.equal(finalized, false);
    assert.equal(succeeded, false);
  });

  it("claims success only after finalize completes", async () => {
    const order = [];
    await runUpgradeCommand(upgradeDependencies({
      execFile: fakeGit({}),
      preflight: async () => ({ proceed: true, restored: false }),
      finalize: async () => {
        order.push("finalize");
      },
      successFn: () => {
        order.push("success");
      },
      printNotes: async () => {
        order.push("notes");
      },
    }));
    assert.deepEqual(order, ["finalize", "success", "notes"]);
  });

  it("does not claim success when finalize fails", async () => {
    let succeeded = false;
    await assert.rejects(
      runUpgradeCommand(upgradeDependencies({
        execFile: fakeGit({}),
        preflight: async () => ({ proceed: true, restored: false }),
        finalize: async () => {
          throw new Error("Update did not finish: the finalize step failed (see above). Fix that, then run the update again.");
        },
        successFn: () => {
          succeeded = true;
        },
      })),
      /Update did not finish/,
    );
    assert.equal(succeeded, false);
  });
});

describe("upgrade fetch, compare, and reset ordering", () => {
  it("does not run the Claude preflight or reset when already current", async () => {
    const events = [];
    let finalized = false;
    await runUpgradeCommand(upgradeDependencies({
      execFile: fakeGit({ head: "same", target: "same", events }),
      preflight: async () => {
        throw new Error("preflight should not run");
      },
      finalize: async () => {
        finalized = true;
      },
    }));

    assert.deepEqual(events, [
      "rev-parse HEAD",
      "fetch --depth=1 origin main --quiet",
      "rev-parse FETCH_HEAD",
    ]);
    assert.equal(finalized, true);
  });

  it("cancels before reset when the user declines the preflight", async () => {
    const events = [];
    await runUpgradeCommand(upgradeDependencies({
      execFile: fakeGit({ events }),
      preflight: async () => {
        events.push("preflight");
        return { proceed: false, restored: false };
      },
    }));

    assert.deepEqual(events, [
      "rev-parse HEAD",
      "fetch --depth=1 origin main --quiet",
      "rev-parse FETCH_HEAD",
      "preflight",
    ]);
  });

  it("resets only after restoration and prints reconnect instructions", async () => {
    const events = [];
    const output = [];
    const oldAdapter = { id: "claude", off: async () => {} };
    let versionRead = 0;
    await runUpgradeCommand(upgradeDependencies({
      execFile: fakeGit({ events }),
      readVersion: async () => {
        versionRead += 1;
        return versionRead === 1 ? "0.8.0" : "1.0.0";
      },
      getClaudeAdapter: () => oldAdapter,
      preflight: async ({ adapter, installedVersion }) => {
        assert.equal(adapter, oldAdapter);
        assert.equal(installedVersion, "0.8.0");
        events.push("preflight");
        return { proceed: true, restored: true };
      },
      successFn: () => {
        throw new Error("generic success output should be replaced");
      },
      log: (message) => output.push(message),
    }));

    assert.deepEqual(events, [
      "rev-parse HEAD",
      "fetch --depth=1 origin main --quiet",
      "rev-parse FETCH_HEAD",
      "preflight",
      "reset --hard new",
      "diff --quiet old new -- packages/setup-cli/package-lock.json",
    ]);
    assert.deepEqual(output, [
      "Update complete. Your original Claude Code settings were restored.",
      "To reconnect with Nexus CLI v1.0.0:\n  nexus claude",
    ]);
  });

  it("passes the installed FireConnect version into Claude preflight", async () => {
    const events = [];
    await runUpgradeCommand(upgradeDependencies({
      execFile: fakeGit({ events }),
      readVersion: async () => "0.9.1",
      preflight: async ({ installedVersion }) => {
        assert.equal(installedVersion, "0.9.1");
        events.push("preflight");
        return { proceed: true, restored: false };
      },
    }));

    assert.ok(events.includes("preflight"));
    assert.ok(events.includes("reset --hard new"));
  });

  it("runs npm install when already current but runtime packages are missing", async () => {
    const events = [];
    await runUpgradeCommand(upgradeDependencies({
      execFile: (file, args) => {
        if (file === "git") {
          const command = args.slice(2);
          events.push(command.join(" "));
          if (command[0] === "rev-parse" && command[1] === "HEAD") {
            return "same\n";
          }
          if (command[0] === "rev-parse" && command[1] === "FETCH_HEAD") {
            return "same\n";
          }
          return "";
        }
        events.push([file, ...args].join(" "));
        return "";
      },
      runtimeDepsPresent: () => false,
    }));

    assert.ok(
      events.some((event) => /npm(\.cmd)? install --omit=dev/.test(event)),
      `expected npm install, got: ${events.join(" | ")}`,
    );
  });

  it("runs npm install when the lockfile is unchanged but packages are missing", async () => {
    const events = [];
    await runUpgradeCommand(upgradeDependencies({
      execFile: (file, args) => {
        if (file === "git") {
          const command = args.slice(2);
          events.push(command.join(" "));
          if (command[0] === "rev-parse" && command[1] === "HEAD") {
            return "old\n";
          }
          if (command[0] === "rev-parse" && command[1] === "FETCH_HEAD") {
            return "new\n";
          }
          return "";
        }
        events.push([file, ...args].join(" "));
        return "";
      },
      preflight: async () => ({ proceed: true, restored: false }),
      runtimeDepsPresent: () => false,
    }));

    assert.ok(events.includes("reset --hard new"));
    assert.ok(events.includes("diff --quiet old new -- packages/setup-cli/package-lock.json"));
    assert.ok(
      events.some((event) => /npm(\.cmd)? install --omit=dev/.test(event)),
      `expected npm install, got: ${events.join(" | ")}`,
    );
  });
});

describe("upgrade finalize process", () => {
  it("runs finalize-install from the updated checkout in a fresh Node process", async () => {
    const calls = [];
    const home = "/tmp/fireconnect-upgrade-home";
    const installDir = `${home}/.nexus/cli`;

    await runUpgradeFinalize(home, installDir, {
      exists: () => true,
      execFile: (file, args, options) => calls.push({ file, args, options }),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, process.execPath);
    assert.deepEqual(calls[0].args, [
      `${installDir}/packages/setup-cli/bin/nexus.mjs`,
      "finalize-install",
    ]);
    assert.equal(calls[0].options.env.HOME, home);
    assert.equal(calls[0].options.stdio, "inherit");
  });

  it("reports a failed finalize child as an unfinished update, not a raw exec error", async () => {
    await assert.rejects(
      runUpgradeFinalize("/tmp/home", "/tmp/home/.nexus/cli", {
        exists: () => true,
        execFile: () => {
          throw new Error("Command failed: node /tmp/home/.nexus/cli/packages/setup-cli/bin/nexus.mjs finalize-install");
        },
      }),
      (error) => {
        assert.match(error.message, /Update did not finish: the finalize step failed/);
        assert.doesNotMatch(error.message, /Command failed/);
        return true;
      },
    );
  });

  it("reports an in-process finalize blocked by a foreign ~/.nexus as unfinished", async () => {
    await assert.rejects(
      runUpgradeFinalize("/tmp/home", "/tmp/home/.nexus/cli", {
        exists: () => false,
        execFile: () => {
          throw new Error("must not spawn");
        },
        finalizeInProcess: async () => ({ notes: [], migrated: false, setupDir: "", renameBlocked: true }),
      }),
      /Update did not finish: rename or remove ~\/\.nexus/,
    );
  });

  it("falls back to in-process finalize when the installed CLI is missing", async () => {
    const calls = [];
    await runUpgradeFinalize("/tmp/home", "/tmp/home/.nexus/cli", {
      exists: () => false,
      execFile: () => {
        throw new Error("must not spawn");
      },
      finalizeInProcess: async (opts) => {
        calls.push(opts);
      },
    });

    assert.deepEqual(calls, [{
      home: "/tmp/home",
      installDir: "/tmp/home/.nexus/cli",
    }]);
  });
});
