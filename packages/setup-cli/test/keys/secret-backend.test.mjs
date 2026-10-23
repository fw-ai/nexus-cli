import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  detectSecretBackend,
  setSecret,
  getSecret,
  hasSecret,
  deleteSecret,
  resetSecretStoreForTests,
  KEY_STORAGE_ENV,
} from "../../lib/keys/secret-store.mjs";
import {
  keyStatusSummary,
  persistApiKeyToKeychain,
  exportFireworksApiKey,
} from "../../lib/keys/api-key.mjs";
import { readGlobalConfig, writeGlobalConfig, setHarnessEnabled, globalConfigPath } from "../../lib/config/global-config.mjs";
import { plaintextMode } from "../../lib/harnesses/vscode/safestorage.mjs";
import { shellHookBlock } from "../../lib/io/shell-env-hook.mjs";
import { verifyKeyExportWorks } from "../../lib/keys/selfcheck.mjs";
import { resolveHarnessOnApiKey } from "../../lib/keys/harness-api-key.mjs";
import { harnessTestArgs, seedOnCommandCatalog, withoutEnvFireworksKey, withLinuxSshEnv } from "../helpers.mjs";

const CLI = path.resolve("bin/nexus.mjs");
const KEY = "fw_backend_test_key_000000000000";

/**
 * Run the CLI in a child process with a fully controlled environment so the
 * file-backend path is exercised (no memory test-seam, no host keychain).
 */
function runCli(args, env) {
  // Mirror the shared runCli helper: seed an empty catalog cache so `on` with
  // a placeholder key falls back to the stale-cache path instead of failing
  // on the mock gateway's 404 for uncataloged keys.
  if (args.includes("on")) {
    seedOnCommandCatalog(env.HOME, args);
  }
  const childEnv = { ...process.env };
  // Never use the in-memory test seam for these; we want the real file backend.
  delete childEnv.NEXUS_SECRET_STORE;
  delete childEnv.NEXUS_TEST;
  // Deleting NEXUS_TEST would re-enable the detached update checker,
  // whose worker outlives the child and races afterEach temp-dir cleanup
  // (ENOTEMPTY). Keep the checker off while still exercising the real backend.
  childEnv.NEXUS_NO_UPDATE_CHECK = "1";
  delete childEnv.FIREWORKS_API_KEY;
  Object.assign(childEnv, env);
  const res = spawnSync(process.execPath, [CLI, ...harnessTestArgs(args)], {
    env: childEnv,
    encoding: "utf8",
    timeout: 20000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function fileBackendEnv(home) {
  return {
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "cfg"),
    [KEY_STORAGE_ENV]: "file",
    KEYRING_FILE_MASTER_KEY: process.env.KEYRING_FILE_MASTER_KEY || "a".repeat(64),
  };
}

describe("secret backend detection + file backend", () => {
  let home;
  let savedEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "fc-backend-"));
    savedEnv = {
      HOME: process.env.HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      [KEY_STORAGE_ENV]: process.env[KEY_STORAGE_ENV],
      NEXUS_SECRET_STORE: process.env.NEXUS_SECRET_STORE,
      NEXUS_TEST: process.env.NEXUS_TEST,
      KEYRING_FILE_MASTER_KEY: process.env.KEYRING_FILE_MASTER_KEY,
    };
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.KEYRING_FILE_MASTER_KEY = process.env.KEYRING_FILE_MASTER_KEY || "a".repeat(64);
    delete process.env.NEXUS_SECRET_STORE;
    delete process.env.NEXUS_TEST;
    resetSecretStoreForTests();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env[KEY_STORAGE_ENV];
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
  });

  it("detectSecretBackend reports the file backend with its on-disk location", async () => {
    const backend = await detectSecretBackend(home);
    assert.equal(backend.backend, "file");
    assert.match(backend.label, /Encrypted file/);
    assert.equal(backend.location, path.join(home, "data", "keyring", "secrets.json"));
    assert.equal(backend.forced, true);
  });

  it("detectSecretBackend reports file on Linux SSH even when libsecret is present", async () => {
    await withLinuxSshEnv(async (isLinux) => {
      if (!isLinux) {
        return;
      }
      const prevStorage = process.env[KEY_STORAGE_ENV];
      delete process.env[KEY_STORAGE_ENV];
      resetSecretStoreForTests();
      try {
        const backend = await detectSecretBackend(home);
        assert.equal(backend.backend, "file");
        assert.match(backend.label, /Encrypted file/);
      } finally {
        if (prevStorage === undefined) {
          delete process.env[KEY_STORAGE_ENV];
        } else {
          process.env[KEY_STORAGE_ENV] = prevStorage;
        }
        process.env[KEY_STORAGE_ENV] = "file";
        resetSecretStoreForTests();
      }
    });
  });

  it("round-trips a key through the encrypted file backend with no plaintext on disk", async () => {
    await setSecret(KEY, home);
    assert.equal(await getSecret(home), KEY);
    assert.equal(await hasSecret(home), true);
    const raw = await readFile(path.join(home, "data", "keyring", "secrets.json"), "utf8");
    assert.ok(!raw.includes(KEY), "key must not appear in plaintext in the store file");
    await deleteSecret(home);
    assert.equal(await hasSecret(home), false);
  });

  it("detectSecretBackend reports unavailable for the null backend", async () => {
    process.env[KEY_STORAGE_ENV] = "null";
    resetSecretStoreForTests();
    const backend = await detectSecretBackend(home);
    assert.equal(backend.backend, "unavailable");
    assert.ok(backend.error);
  });

  it("detectSecretBackend ignores an unknown backend value (falls back to auto)", async () => {
    process.env[KEY_STORAGE_ENV] = "bogus";
    resetSecretStoreForTests();
    const backend = await detectSecretBackend(home);
    // On the CI host a native keychain may or may not be present; either keychain
    // or file is acceptable — just not "unavailable" and not "memory".
    assert.notEqual(backend.backend, "memory");
    assert.notEqual(backend.backend, "unavailable");
  });

  it("persistApiKeyToKeychain refuses and leaves config unchanged when the backend is unavailable", async () => {
    process.env[KEY_STORAGE_ENV] = "null";
    resetSecretStoreForTests();
    // Seed an existing config so we can prove it is NOT overwritten on failure.
    await writeGlobalConfig(home, { apiKey: "{env:FIREWORKS_API_KEY}", harnesses: {} });

    // The refusal must name the headless path (env var) and clarify that
    // login flags that pass a key still need storage.
    await assert.rejects(
      () => persistApiKeyToKeychain(home, KEY),
      /Cannot store the API key[\s\S]*FIREWORKS_API_KEY[\s\S]*--api-key/,
    );

    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, "{env:FIREWORKS_API_KEY}", "config must be untouched on failure");
  });

  it("keyStatusSummary includes backend, location, and perHarness entries", async () => {
    await persistApiKeyToKeychain(home, KEY);
    await setHarnessEnabled(home, "claude", true, { mode: "direct" });

    const summary = await keyStatusSummary(home);
    assert.equal(summary.backend, "file");
    assert.ok(summary.location);
    assert.equal(summary.keychainPresent, true);
    assert.ok(Array.isArray(summary.perHarness));
    assert.ok(summary.perHarness.length >= 6);

    const claude = summary.perHarness.find((h) => h.id === "claude");
    assert.ok(claude, "claude entry present");
    assert.equal(claude.enabled, true);
    assert.match(claude.readsFrom, /X-Fireworks-Api-Key header in settings\.json/);
    assert.match(claude.storage, /Encrypted file/);
    assert.match(
      summary.perHarness.find((h) => h.id === "opencode").readsFrom,
      /literal apiKey in opencode\.json/,
    );
    assert.match(
      summary.perHarness.find((h) => h.id === "pi").readsFrom,
      /literal key in auth\.json/,
    );

    const vscode = summary.perHarness.find((h) => h.id === "vscode");
    assert.equal(vscode.storage, "IDE Electron safeStorage (encrypted)");
    const cursor = summary.perHarness.find((h) => h.id === "cursor");
    assert.equal(cursor.storage, "Cursor Electron safeStorage (secret://, encrypted; legacy plaintext fallback)");
  });

  it("keyStatusSummary masks legacy global literals and points to login", async () => {
    const legacyKey = "fw_legacy_status_key_1234567890";
    await writeGlobalConfig(home, { apiKey: legacyKey });

    const summary = await keyStatusSummary(home);
    assert.equal(summary.configRef, "(legacy literal — run `nexus login` to move it into secure storage)");
    assert.doesNotMatch(summary.configRef, /upgrade/);
  });

  it("keychain fallback repairs the config ref so the shell hook can install", async () => {
    await withoutEnvFireworksKey(async () => {
      // Seed the key in the file backend, but leave config.json ABSENT (simulating
      // a lost {keychain} ref). resolveHarnessOnApiKey should recover the key from
      // the store AND repair config.json to {keychain:fireworks-api-key} — otherwise the
      // shell env hook (gated on isKeychainConfigRef) wouldn't install and
      // Codex/OpenCode/Pi would be enabled with {env:…} but no exported key.
      await setSecret(KEY, home);
      // No config.json present.
      const resolved = await resolveHarnessOnApiKey({
        apiKey: "",
        home,
        harnessEnvRef: "{env:FIREWORKS_API_KEY}",
        getExistingHarnessKey: async () => "",
      });
      assert.equal(resolved.effectiveKey, KEY, "key recovered from the keychain");

      const config = await readGlobalConfig(home);
      assert.equal(config.apiKey, "{keychain:fireworks-api-key}", "config ref repaired so the shell hook installs");
    });
  });

  it("keychain fallback repairs legacy env-ref config when keychain holds the secret", async () => {
    await withoutEnvFireworksKey(async () => {
      await setSecret(KEY, home);
      await writeGlobalConfig(home, { apiKey: "{env:FIREWORKS_API_KEY}" });
      const resolved = await resolveHarnessOnApiKey({
        apiKey: "",
        home,
        harnessEnvRef: "{env:FIREWORKS_API_KEY}",
        getExistingHarnessKey: async () => "",
      });
      assert.equal(resolved.effectiveKey, KEY);
      assert.equal(resolved.source, "global-keychain");
      const config = await readGlobalConfig(home);
      assert.equal(config.apiKey, "{keychain:fireworks-api-key}");
    });
  });
});

describe("configure / on via CLI with file backend", () => {
  let home;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "fc-cli-backend-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("claude on --api-key stores in the file backend and writes the X-Fireworks-Api-Key custom header", async () => {
    const res = runCli(["claude", "on", "--api-key", KEY], fileBackendEnv(home));
    assert.equal(res.code, 0, res.stderr);
    await assert.doesNotReject(() => readFile(path.join(home, "data/keyring/secrets.json")));

    const settings = JSON.parse(await readFile(path.join(home, ".claude/settings.json"), "utf8"));
    // Claude direct mode now authenticates via the X-Fireworks-Api-Key custom
    // header (no apiKeyHelper). The key is written in plaintext there — the
    // documented tradeoff — while the OS keychain/file backend remains the
    // source of truth for `key export` and other harnesses.
    assert.equal(settings.apiKeyHelper, undefined);
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, new RegExp(`X-Fireworks-Api-Key: ${KEY}`));
  });

  it("harness on refuses with a friendly error when the backend is unavailable", async () => {
    const env = fileBackendEnv(home);
    env[KEY_STORAGE_ENV] = "null";
    const res = runCli(["claude", "on", "--api-key", KEY], env);
    assert.notEqual(res.code, 0);
    // Graceful failure (no stack-trace crash) when nothing can persist the key.
    assert.match(res.stderr, /Cannot store the API key|Storage verification failed/);
    // Config must not have been created with a keychain ref pointing at nothing.
    try {
      const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
      assert.notEqual(config.apiKey, "{keychain:fireworks-api-key}");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });
});

describe("shell hook interactive hint", () => {
  it("shellHookBlock guards the empty-key hint to interactive shells ([ -t 2 ])", () => {
    const block = shellHookBlock("/tmp/fc-shell-hook-test");
    assert.match(block, /export FIREWORKS_API_KEY="\$\(/);
    assert.match(block, /\[ -t 2 \]/);
    assert.match(block, /nexus status/);
    // The hint must NOT execute `nexus status` via command substitution:
    // the echo argument is single-quoted so backticks are literal.
    const echoLine = block.split("\n").find((l) => l.includes("echo"));
    assert.ok(echoLine, "echo hint line present");
    assert.ok(/^  echo '/.test(echoLine), "echo argument is single-quoted (no command substitution)");
  });
});


describe("vscode-safestorage plaintextMode strict parse", () => {
  it("treats only the exact value '1' as enabled (not '0' or other strings)", () => {
    const prev = process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    try {
      for (const v of ["0", "false", "yes", "true", ""]) {
        process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = v;
        assert.equal(plaintextMode(), false, `value ${JSON.stringify(v)} must NOT enable plaintext`);
      }
      process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = "1";
      assert.equal(plaintextMode(), true);
    } finally {
      if (prev === undefined) delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
      else process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = prev;
    }
  });
});

describe("key export self-check", () => {
  let home;
  let savedEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "fc-selfcheck-"));
    savedEnv = {
      HOME: process.env.HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      [KEY_STORAGE_ENV]: process.env[KEY_STORAGE_ENV],
      NEXUS_SECRET_STORE: process.env.NEXUS_SECRET_STORE,
      NEXUS_TEST: process.env.NEXUS_TEST,
      KEYRING_FILE_MASTER_KEY: process.env.KEYRING_FILE_MASTER_KEY,
    };
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.KEYRING_FILE_MASTER_KEY = process.env.KEYRING_FILE_MASTER_KEY || "a".repeat(64);
    delete process.env.NEXUS_SECRET_STORE;
    delete process.env.NEXUS_TEST;
    resetSecretStoreForTests();

    // Install a real launcher at ~/.local/bin/nexus so the self-check
    // resolves the CLI the way it does in production (not via process.argv[1],
    // which is the test file in this process).
    const binDir = path.join(home, ".local/bin");
    await mkdir(binDir, { recursive: true });
    const launcher = path.join(binDir, "nexus");
    await writeFile(
      launcher,
      `#!/usr/bin/env bash\nexec "${process.execPath}" "${CLI}" "$@"\n`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env[KEY_STORAGE_ENV];
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
  });

  it("verifyKeyExportWorks succeeds when a key is stored in the file backend", async () => {
    await setSecret(KEY, home);
    const result = await verifyKeyExportWorks(home, { expectedKey: KEY });
    assert.equal(result.ok, true, result.reason ?? "expected ok");
  });

  it("verifyKeyExportWorks reports a failure when no key is stored", async () => {
    const result = await verifyKeyExportWorks(home);
    assert.equal(result.ok, false);
    assert.ok(result.reason);
  });
});

describe("exportFireworksApiKey --stored-only", () => {
  let home;
  let savedEnv;

  const STORED = "fw_stored_only_test_000000000000";
  const ENV_ONLY = "fw_stored_only_env_000000000000";

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "fc-export-stored-"));
    savedEnv = {
      HOME: process.env.HOME,
      FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      [KEY_STORAGE_ENV]: process.env[KEY_STORAGE_ENV],
      NEXUS_SECRET_STORE: process.env.NEXUS_SECRET_STORE,
      NEXUS_TEST: process.env.NEXUS_TEST,
      KEYRING_FILE_MASTER_KEY: process.env.KEYRING_FILE_MASTER_KEY,
    };
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.KEYRING_FILE_MASTER_KEY = process.env.KEYRING_FILE_MASTER_KEY || "a".repeat(64);
    delete process.env.NEXUS_SECRET_STORE;
    delete process.env.NEXUS_TEST;
    resetSecretStoreForTests();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env[KEY_STORAGE_ENV];
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
  });

  it("falls back to FIREWORKS_API_KEY when nothing is stored", async () => {
    process.env.FIREWORKS_API_KEY = ENV_ONLY;
    const key = await exportFireworksApiKey(home, { storedOnly: true });
    assert.equal(key, ENV_ONLY);
  });

  it("prefers the stored key over FIREWORKS_API_KEY", async () => {
    await setSecret(STORED, home);
    process.env.FIREWORKS_API_KEY = ENV_ONLY;
    const key = await exportFireworksApiKey(home, { storedOnly: true });
    assert.equal(key, STORED);
  });

  it("throws when stored-only and neither store nor env has a key", async () => {
    delete process.env.FIREWORKS_API_KEY;
    await assert.rejects(
      () => exportFireworksApiKey(home, { storedOnly: true }),
      /No Fireworks API key found/,
    );
  });
});
