import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  SHIM_AGENT_LABEL,
  SUPPORTED_PLATFORMS,
  buildLaunchAgentPlist,
  buildShimServiceFile,
  buildSystemdUnit,
  retireLegacyShimAgent,
  shimServiceFilePath,
  shimTrustOptions,
  startLaunchAgent,
  startShimService,
  startSystemdUnit,
  stopLaunchAgent,
  stopShimService,
  stopSystemdUnit,
} from "../../../lib/harnesses/claude-desktop/platform.mjs";
import { desktopDataDir, firstPartyDir, thirdPartyDir } from "../../../lib/harnesses/claude-desktop/lineup.mjs";

/** Fake command runner: records invocations, replays scripted outputs. */
function fakeRunner(script = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    const argv = [cmd, ...args];
    calls.push(argv.join(" "));
    const key = argv.slice(0, 2).join(" ");
    const reply = script[key] ?? script[argv.join(" ")];
    if (reply instanceof Error) throw reply;
    return { stdout: typeof reply === "string" ? reply : "", stderr: "" };
  };
  return { run, calls };
}

/**
 * The global test preload sets NEXUS_TEST=1, which correctly gates the
 * default runner. These tests use injected fakes, so the gate is lifted for
 * the duration while every real binary path stays unreached.
 */
function withoutTestGate(fn) {
  return async () => {
    const prev = process.env.NEXUS_TEST;
    delete process.env.NEXUS_TEST;
    try {
      await fn();
    } finally {
      if (prev !== undefined) process.env.NEXUS_TEST = prev;
    }
  };
}

test("launchd plist is deterministic, escaped, and owned by our label", () => {
  const plist = buildLaunchAgentPlist({
    nodeExec: "/usr/local/bin/node <&>",
    entry: "/tmp/shim <script>.mjs",
    home: "/Users/test <home>",
    logPath: "/tmp/log",
    errorPath: "/tmp/err",
  });
  assert.match(plist, new RegExp(`<string>${SHIM_AGENT_LABEL.replace(/\./g, "\\.")}</string>`));
  assert.ok(plist.includes("/usr/local/bin/node &lt;&amp;&gt;"));
  assert.ok(plist.includes("<key>RunAtLoad</key><true/>"));
  // The shim is stateless and never exits deliberately: always keep it alive
  // (launchd throttles respawns to 10s). `off` bootouts the job first, so a
  // removed lane never respawns.
  assert.ok(plist.includes("<key>KeepAlive</key><true/>"));
  assert.ok(!plist.includes("FIREWORKS"), "no credentials in the plist");
});

test("shim trusts the system CA store and an explicit extra CA bundle (TLS-inspecting proxies)", () => {
  const trust = shimTrustOptions(
    { NODE_EXTRA_CA_CERTS: "/Library/Zscaler <root>.pem", FIREWORKS_API_KEY: "fw_secret" },
    new Set(["--use-system-ca"]),
  );
  assert.deepEqual(trust, {
    nodeArgs: ["--use-system-ca"],
    env: { NODE_EXTRA_CA_CERTS: "/Library/Zscaler <root>.pem" },
  });
  const plist = buildLaunchAgentPlist({
    nodeExec: "/usr/local/bin/node", entry: "/tmp/shim.mjs", home: "/Users/test",
    logPath: "/tmp/log", errorPath: "/tmp/err", ...trust,
  });
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>--use-system-ca<\/string>\s*<string>\/tmp\/shim\.mjs<\/string>/);
  assert.ok(plist.includes("<key>NODE_EXTRA_CA_CERTS</key><string>/Library/Zscaler &lt;root&gt;.pem</string>"));
  assert.ok(plist.includes("<key>HOME</key><string>/Users/test</string>"));
  assert.ok(!plist.includes("fw_secret"), "only the CA path is carried over");
});

test("shim omits --use-system-ca on a Node that would reject it", () => {
  assert.deepEqual(shimTrustOptions({}, new Set()), { nodeArgs: [], env: {} });
});

test("startLaunchAgent reloads an already-loaded agent with the current plist", withoutTestGate(async () => {
  const already = new Error("bootstrap failed");
  already.stderr = "5: Input/output error (bootstrap already done)";
  const calls = [];
  let bootstraps = 0;
  const run = async (cmd, args) => {
    const argv = [cmd, ...args];
    calls.push(argv.join(" "));
    if (argv[1] === "bootstrap") {
      bootstraps += 1;
      // First bootstrap hits the loaded job; the reload bootstrap succeeds.
      if (bootstraps === 1) throw already;
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  await startLaunchAgent("/tmp/owned.plist", { run, allowSystemChanges: true });
  // Fresh load: bootstrap -> bootout (stale job) -> bootstrap -> kickstart.
  assert.equal(bootstraps, 2);
  assert.ok(calls.some((c) => c.includes("bootout") && c.includes(SHIM_AGENT_LABEL)));
  assert.ok(calls.some((c) => c.includes("kickstart") && c.includes(SHIM_AGENT_LABEL)));
}));

test("startLaunchAgent propagates real bootstrap failures", withoutTestGate(async () => {
  const { run } = fakeRunner({ "/bin/launchctl bootstrap": new Error("bootstrap: no such file") });
  await assert.rejects(startLaunchAgent("/tmp/x.plist", { run, allowSystemChanges: true }), /no such file/);
}));

test("stopLaunchAgent treats an unloaded agent as success", withoutTestGate(async () => {
  const gone = new Error("bootout failed");
  gone.stderr = "No such process";
  const { run, calls } = fakeRunner({ "/bin/launchctl bootout": gone });
  await stopLaunchAgent({ run, allowSystemChanges: true });
  assert.ok(calls.some((c) => c.includes("bootout")));
}));

test("launchd helpers refuse to run without the explicit opt-in", withoutTestGate(async () => {
  await assert.rejects(startLaunchAgent("/tmp/x.plist", {}), /explicit opt-in/);
  await assert.rejects(stopLaunchAgent({}), /explicit opt-in/);
}));

test("launchd helpers stay gated under NEXUS_TEST=1", async () => {
  const { run } = fakeRunner();
  await assert.rejects(startLaunchAgent("/tmp/x.plist", { run, allowSystemChanges: true }), /NEXUS_TEST=1/);
  await assert.rejects(stopLaunchAgent({ run, allowSystemChanges: true }), /NEXUS_TEST=1/);
});

// ---------------------------------------------------------------------------
// Linux: systemd user unit + platform-aware paths
// ---------------------------------------------------------------------------

test("desktop data dirs follow each platform's Electron userData layout", () => {
  const home = "/home/u";
  assert.equal(firstPartyDir(home, { platform: "darwin" }), "/home/u/Library/Application Support/Claude");
  assert.equal(thirdPartyDir(home, { platform: "darwin" }), "/home/u/Library/Application Support/Claude-3p");
  assert.equal(firstPartyDir(home, { platform: "linux", env: {} }), "/home/u/.config/Claude");
  assert.equal(thirdPartyDir(home, { platform: "linux", env: {} }), "/home/u/.config/Claude-3p");
  // XDG_CONFIG_HOME wins for the real home only; --home <dir> stays self-contained.
  const env = { XDG_CONFIG_HOME: "/xdg/cfg" };
  assert.equal(thirdPartyDir(home, { platform: "linux", env, realHome: home }), "/xdg/cfg/Claude-3p");
  assert.equal(thirdPartyDir("/tmp/other", { platform: "linux", env, realHome: home }), "/tmp/other/.config/Claude-3p");
  // A relative XDG value is ignored (the spec requires absolute paths).
  assert.equal(desktopDataDir(home, "Claude", { platform: "linux", env: { XDG_CONFIG_HOME: "rel" }, realHome: home }), "/home/u/.config/Claude");
});

test("shim service file lives in LaunchAgents on macOS and systemd/user on Linux", () => {
  assert.equal(shimServiceFilePath("/home/u", { platform: "darwin" }), `/home/u/Library/LaunchAgents/${SHIM_AGENT_LABEL}.plist`);
  assert.equal(shimServiceFilePath("/home/u", { platform: "linux" }), `/home/u/.config/systemd/user/${SHIM_AGENT_LABEL}.service`);
  // Same config-dir rule as Desktop's own data: XDG_CONFIG_HOME for the real home only.
  const xdg = { XDG_CONFIG_HOME: "/xdg/cfg" };
  assert.equal(shimServiceFilePath("/home/u", { platform: "linux", env: xdg, realHome: "/home/u" }), `/xdg/cfg/systemd/user/${SHIM_AGENT_LABEL}.service`);
  assert.equal(shimServiceFilePath("/tmp/box", { platform: "linux", env: xdg, realHome: "/home/u" }), `/tmp/box/.config/systemd/user/${SHIM_AGENT_LABEL}.service`);
  assert.deepEqual(SUPPORTED_PLATFORMS, ["darwin", "linux"]);
});

test("systemd unit is deterministic, quoted, restarts always, and carries no credentials", () => {
  const unit = buildSystemdUnit({
    nodeExec: "/usr/local/bin/node",
    entry: '/home/u/.nexus/cli/lib/harnesses/claude-desktop/shim "x".mjs',
    home: "/home/u ser",
    logPath: "/home/u ser/.nexus/claude-desktop/shim.log",
    errorPath: "/home/u ser/.nexus/claude-desktop/shim.err.log",
    processEnv: { XDG_CONFIG_HOME: "/home/u ser/cfg%dir" },
    realHome: "/home/u ser",
  });
  assert.ok(unit.includes('ExecStart="/usr/local/bin/node" "/home/u/.nexus/cli/lib/harnesses/claude-desktop/shim \\"x\\".mjs" "--home" "/home/u ser"'));
  assert.ok(unit.includes('Environment="HOME=/home/u ser"'));
  // % is a specifier in unit files; it must be doubled to stay literal.
  assert.ok(unit.includes('Environment="XDG_CONFIG_HOME=/home/u ser/cfg%%dir"'));
  assert.ok(unit.includes("Restart=always"));
  assert.ok(unit.includes("StandardOutput=append:/home/u ser/.nexus/claude-desktop/shim.log"));
  assert.ok(unit.includes("WantedBy=default.target"));
  assert.ok(!unit.includes("FIREWORKS"), "no credentials in the unit");
  // Without XDG_CONFIG_HOME only HOME is exported.
  const plain = buildSystemdUnit({ nodeExec: "/n", entry: "/e", home: "/h", logPath: "/l", errorPath: "/x", processEnv: {} });
  assert.equal((plain.match(/^Environment=/gm) ?? []).length, 1);
});

test("systemd unit carries the shim trust options alongside XDG_CONFIG_HOME", () => {
  const unit = buildSystemdUnit({
    nodeExec: "/n",
    entry: "/e",
    home: "/home/u",
    logPath: "/l",
    errorPath: "/x",
    ...shimTrustOptions({ NODE_EXTRA_CA_CERTS: "/etc/ssl/corp root.pem" }, new Set(["--use-system-ca"])),
    processEnv: { XDG_CONFIG_HOME: "/xdg/cfg" },
    realHome: "/home/u",
  });
  assert.ok(unit.includes('ExecStart="/n" "--use-system-ca" "/e" "--home" "/home/u"'));
  assert.ok(unit.includes('Environment="NODE_EXTRA_CA_CERTS=/etc/ssl/corp root.pem"'));
  assert.ok(unit.includes('Environment="XDG_CONFIG_HOME=/xdg/cfg"'));
});

test("systemd unit skips XDG_CONFIG_HOME for a --home sandbox, matching thirdPartyDir", () => {
  const processEnv = { XDG_CONFIG_HOME: "/xdg/cfg" };
  const unit = buildSystemdUnit({ nodeExec: "/n", entry: "/e", home: "/tmp/sandbox", logPath: "/l", errorPath: "/x", processEnv, realHome: "/home/u" });
  assert.ok(!unit.includes("XDG_CONFIG_HOME"));
  assert.equal(thirdPartyDir("/tmp/sandbox", { platform: "linux", env: processEnv, realHome: "/home/u" }), "/tmp/sandbox/.config/Claude-3p");
});

test("buildShimServiceFile picks the plist on macOS and the unit on Linux", () => {
  const args = { nodeExec: "/n", entry: "/e", home: "/h", logPath: "/l", errorPath: "/x", env: {} };
  assert.ok(buildShimServiceFile(args, { platform: "darwin" }).startsWith("<?xml"));
  assert.ok(buildShimServiceFile(args, { platform: "linux" }).startsWith("[Unit]"));
});

test("startSystemdUnit reloads, enables, then restarts our unit only", withoutTestGate(async () => {
  const { run, calls } = fakeRunner();
  await startSystemdUnit("/home/u/.config/systemd/user/x.service", { run, allowSystemChanges: true });
  assert.deepEqual(calls, [
    "systemctl --user daemon-reload",
    "systemctl --user enable /home/u/.config/systemd/user/x.service",
    `systemctl --user restart ${SHIM_AGENT_LABEL}.service`,
  ]);
}));

test("startSystemdUnit explains a missing user manager instead of a raw bus error", withoutTestGate(async () => {
  const bus = new Error("systemctl failed");
  bus.stderr = "Failed to connect to bus: No medium found";
  const { run } = fakeRunner({ "systemctl --user": bus });
  await assert.rejects(startSystemdUnit("/x.service", { run, allowSystemChanges: true }), /No systemd user session/);
}));

test("startSystemdUnit propagates a real restart failure", withoutTestGate(async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args[1] === "restart") { const e = new Error("restart failed"); e.stderr = "Job failed"; throw e; }
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(startSystemdUnit("/x.service", { run, allowSystemChanges: true }), /restart failed/);
}));

test("stopSystemdUnit treats an unloaded unit as success, removes the file, and reloads", withoutTestGate(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fc-unit-"));
  const unitPath = path.join(dir, "x.service");
  await writeFile(unitPath, "[Unit]\n");
  try {
    const gone = new Error("disable failed");
    gone.stderr = `Unit ${SHIM_AGENT_LABEL}.service does not exist.`;
    const calls = [];
    const run = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args[1] === "disable") throw gone;
      return { stdout: "", stderr: "" };
    };
    await stopSystemdUnit({ run, allowSystemChanges: true, unitPath });
    assert.ok(calls[0].includes(`disable --now ${SHIM_AGENT_LABEL}.service`));
    assert.equal(calls.at(-1), "systemctl --user daemon-reload");
    await assert.rejects(stat(unitPath), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test("stopSystemdUnit propagates unexpected failures", withoutTestGate(async () => {
  const bad = new Error("disable failed");
  bad.stderr = "Access denied";
  const { run } = fakeRunner({ "systemctl --user": bad });
  await assert.rejects(stopSystemdUnit({ run, allowSystemChanges: true }), /disable failed/);
}));

test("platform dispatchers route to launchctl on macOS and systemctl on Linux", withoutTestGate(async () => {
  const mac = fakeRunner();
  await startShimService("/p.plist", { run: mac.run, allowSystemChanges: true, platform: "darwin" });
  await stopShimService({ run: mac.run, allowSystemChanges: true, platform: "darwin" });
  assert.ok(mac.calls.every((c) => c.startsWith("/bin/launchctl ")), mac.calls.join("\n"));
  const linux = fakeRunner();
  await startShimService("/u.service", { run: linux.run, allowSystemChanges: true, platform: "linux" });
  await stopShimService({ run: linux.run, allowSystemChanges: true, platform: "linux" });
  assert.ok(linux.calls.every((c) => c.startsWith("systemctl --user ")), linux.calls.join("\n"));
}));

test("systemd helpers refuse to run without the explicit opt-in and under NEXUS_TEST=1", async () => {
  const { run } = fakeRunner();
  await assert.rejects(startSystemdUnit("/x.service", { run, allowSystemChanges: true }), /NEXUS_TEST=1/);
  await assert.rejects(stopSystemdUnit({ run, allowSystemChanges: true }), /NEXUS_TEST=1/);
  await withoutTestGate(async () => {
    await assert.rejects(startSystemdUnit("/x.service", { run }), /explicit opt-in/);
    await assert.rejects(stopSystemdUnit({ run }), /explicit opt-in/);
  })();
});

test("systemd unit keeps a % in the log paths literal", () => {
  const unit = buildSystemdUnit({ nodeExec: "/n", entry: "/e", home: "/h", logPath: "/h/100%/shim.log", errorPath: "/h/100%/err.log", processEnv: {} });
  assert.ok(unit.includes("StandardOutput=append:/h/100%%/shim.log"));
  assert.ok(unit.includes("StandardError=append:/h/100%%/err.log"));
});

test("retiring the pre-rename shim job never runs launchctl on Linux", withoutTestGate(async () => {
  const { run, calls } = fakeRunner();
  await retireLegacyShimAgent("/home/u", { run, allowSystemChanges: true, platform: "linux" });
  assert.deepEqual(calls, []);
}));
