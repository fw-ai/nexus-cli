import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";

// Until the user picks "Always Allow", macOS shows a keychain prompt for every
// process that reads the stored key, and a desktop refresh runs one CLI
// process per command below. These specs run the real CLI against a fake
// macOS keychain that logs each call, and pin which commands read the key.

const CLI = new URL("../../bin/nexus.mjs", import.meta.url).pathname;
const SECRET_STORE = new URL("../../lib/keys/secret-store.mjs", import.meta.url).href;
const FAKE_KEYCHAIN = new URL("./fixtures/fake-cross-keychain.mjs", import.meta.url).href;
const USE_FAKE = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(FAKE_KEYCHAIN)});`;
// The global mock gateway serves the model catalog only to keys that say so.
const STORED_KEY = "fw_cataloged_keychain_reads";
const DESKTOP_TOOLS = [
  "claude", "claude-desktop", "codex", "opencode", "pi",
  "cursor", "vscode", "copilot-app", "copilot-cli", "deepseek",
];

/** @param {string} home */
function env(home, backend = "native-macos") {
  const vars = {
    ...process.env,
    HOME: home,
    FAKE_KEYCHAIN: "working",
    FAKE_KEYCHAIN_BACKEND: backend,
    FAKE_KEYCHAIN_LOG: path.join(home, "keychain-calls.log"),
    NEXUS_CACHE_DIR: path.join(home, "cache"),
    FIRECONNECT_NO_UPDATE_CHECK: "1",
  };
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "NEXUS_KEY_STORAGE", "NEXUS_SECRET_STORE", "NEXUS_TEST", "FIREWORKS_API_KEY", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT", "KEYRING_FILE_MASTER_KEY", "TS_KEYRING_BACKEND"]) {
    delete vars[key];
  }
  return vars;
}

/**
 * Run one CLI command as its own process; return its output and the keychain
 * calls it made.
 * @param {string} home
 * @param {string[]} args
 */
function nexus(home, args, { backend } = {}) {
  const log = path.join(home, "keychain-calls.log");
  rmSync(log, { force: true });
  const result = spawnSync(process.execPath, ["--import", USE_FAKE, CLI, ...args], {
    env: env(home, backend),
    encoding: "utf8",
    timeout: 60_000,
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { ...result, reads: calls.filter((call) => call === "getPassword").length, calls };
}

/** A signed-in home: the key in the (fake) keychain, config pointing at it. */
async function signedInHome(prefix) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(home, ".nexus"), { recursive: true });
  await writeFile(path.join(home, ".nexus", "config.json"), JSON.stringify({ apiKey: "{keychain:fireworks-api-key}" }));
  await writeFile(path.join(home, ".nexus", "key-storage.json"), JSON.stringify({ storage: "keychain" }));
  await writeFile(path.join(home, "fake-keychain.json"), JSON.stringify({ "FireworksAI/fireworks-api-key": STORED_KEY }));
  return home;
}

describe("keychain reads during a desktop refresh", () => {
  let home = "";
  before(async () => {
    home = await signedInHome("nexus-keychain-reads-");
    // Connect one tool so its status reports a live key rather than "off".
    const on = nexus(home, ["deepseek", "on", "--skip-install-check"]);
    assert.equal(on.status, 0, on.stderr);
  });
  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("`status --json` reads the key once, for its live check", () => {
    const result = nexus(home, ["status", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.auth.signedIn, true);
    assert.equal(status.keychainPresent, true);
    assert.equal(result.reads, 1);
  });

  for (const tool of DESKTOP_TOOLS) {
    it(`\`${tool} status --json\` never reads the key`, () => {
      const result = nexus(home, [tool, "status", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.reads, 0, `${tool} status read the keychain`);
    });
  }

  it("`deepseek status` still reports the stored key", () => {
    const result = nexus(home, ["deepseek", "status", "--json"]);
    assert.equal(JSON.parse(result.stdout).hasAuthToken, true);
    assert.deepEqual(result.calls, ["itemExists"]);
  });

  it("`model list` reads the key only to fetch a stale catalog", async () => {
    await rm(path.join(home, "cache"), { recursive: true, force: true });
    const cold = nexus(home, ["model", "list", "--json"]);
    assert.equal(cold.status, 0, cold.stderr);
    assert.equal(JSON.parse(cold.stdout).source, "network");
    assert.equal(cold.reads, 1);

    const warm = nexus(home, ["model", "list", "--json"]);
    assert.equal(warm.status, 0, warm.stderr);
    assert.equal(JSON.parse(warm.stdout).source, "cache");
    assert.equal(warm.reads, 0);

    const refresh = nexus(home, ["model", "list", "--json", "--refresh"]);
    assert.equal(refresh.status, 0, refresh.stderr);
    assert.equal(refresh.reads, 1);
  });

  it("`key export` still reads and prints the key", () => {
    const result = nexus(home, ["key", "export"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), STORED_KEY);
    assert.equal(result.reads, 1);
  });
});

describe("stored-key presence without a read", () => {
  it("`model list` refuses without reading when no key is stored", async () => {
    const home = await signedInHome("nexus-keychain-reads-none-");
    try {
      await writeFile(path.join(home, "fake-keychain.json"), "{}");
      const result = nexus(home, ["model", "list", "--json"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /API key/i);
      assert.equal(result.reads, 0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reads to check presence where reads don't prompt (Secret Service)", async () => {
    const home = await signedInHome("nexus-keychain-reads-linux-");
    try {
      const result = spawnSync(process.execPath, [
        "--import", USE_FAKE, "--input-type=module", "-e",
        `const s = await import(${JSON.stringify(SECRET_STORE)}); console.log(await s.hasSecret(process.env.HOME));`,
      ], { env: env(home, "secret-service"), encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "true");
      const calls = readFileSync(path.join(home, "keychain-calls.log"), "utf8").split("\n").filter(Boolean);
      assert.deepEqual(calls, ["getPassword"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
