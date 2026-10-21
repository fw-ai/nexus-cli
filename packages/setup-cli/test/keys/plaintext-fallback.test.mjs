import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  KEY_STORAGE_ENV,
  resetSecretStoreForTests,
  setSecret,
  getSecret,
  reprobeKeyStorage,
  detectSecretBackend,
} from "../../lib/keys/secret-store.mjs";
import {
  readKeyStorageCache,
  REPROBE_KEY_STORAGE_ENV,
} from "../../lib/keys/storage-cache.mjs";
import { plaintextSecretPath, readPlaintextSecret, writePlaintextSecret } from "../../lib/keys/plaintext-secret-store.mjs";
import { globalConfigPath } from "../../lib/config/global-config.mjs";

const CLI = path.resolve("bin/nexus.mjs");

function runCli(args, env) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NEXUS_SECRET_STORE;
  delete childEnv.FIREWORKS_API_KEY;
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: childEnv,
    encoding: "utf8",
    timeout: 30000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Force the encrypted-file backend to fail without disabling plaintext fallback. */
async function blockSecureKeyStorage(home) {
  const blocked = path.join(home, "blocked-xdg");
  await writeFile(blocked, "not-a-directory");
  process.env.XDG_DATA_HOME = blocked;
  process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
  process.env[KEY_STORAGE_ENV] = "file";
  resetSecretStoreForTests();
}

describe("plaintext secret fallback", () => {
  let home;
  let savedEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "fc-plaintext-"));
    savedEnv = {
      HOME: process.env.HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      [KEY_STORAGE_ENV]: process.env[KEY_STORAGE_ENV],
      NEXUS_SECRET_STORE: process.env.NEXUS_SECRET_STORE,
      NEXUS_TEST: process.env.NEXUS_TEST,
    };
    process.env.HOME = home;
    delete process.env.NEXUS_SECRET_STORE;
    delete process.env.NEXUS_TEST;
    await blockSecureKeyStorage(home);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
  });

  it("setSecret falls back to plaintext and caches the storage choice", async () => {
    await setSecret("fw_plaintext_fallback_key", home);
    assert.equal(await getSecret(home), "fw_plaintext_fallback_key");
    assert.equal(await readKeyStorageCache(home), "plaintext");
    const file = plaintextSecretPath(home);
    assert.ok(file);
    const raw = await readFile(file, "utf8");
    assert.equal(raw.trim(), "fw_plaintext_fallback_key");
  });

  it("reprobeKeyStorage clears plaintext cache and keeps key readable", async () => {
    await setSecret("fw_reprobe_cached_key", home);
    assert.equal(await readKeyStorageCache(home), "plaintext");

    const result = await reprobeKeyStorage(home);
    assert.equal(result.migrated, false);
    assert.equal(await getSecret(home), "fw_reprobe_cached_key");
    assert.equal(await readKeyStorageCache(home), "plaintext");
  });

  it("NEXUS_REPROBE_KEY_STORAGE ignores cache for one run", async () => {
    await setSecret("fw_env_reprobe_key", home);
    assert.equal(await readKeyStorageCache(home), "plaintext");

    process.env[REPROBE_KEY_STORAGE_ENV] = "1";
    try {
      await setSecret("fw_env_reprobe_key", home);
      assert.equal(await getSecret(home), "fw_env_reprobe_key");
    } finally {
      delete process.env[REPROBE_KEY_STORAGE_ENV];
    }
  });

  it("getSecret prefers --home plaintext over real HOME secure store when cache is missing", async () => {
    const realHome = await mkdtemp(path.join(os.tmpdir(), "fc-real-home-"));
    const altHome = await mkdtemp(path.join(os.tmpdir(), "fc-alt-home-"));
    try {
      delete process.env[KEY_STORAGE_ENV];
      delete process.env.XDG_DATA_HOME;
      resetSecretStoreForTests();
      process.env.HOME = realHome;
      process.env[KEY_STORAGE_ENV] = "file";
      process.env.XDG_DATA_HOME = path.join(realHome, "data");
      process.env.XDG_CONFIG_HOME = path.join(realHome, "cfg");
      await setSecret("fw_real_home_secure_key", realHome);

      process.env.HOME = realHome;
      await writePlaintextSecret(altHome, "fw_alt_home_plaintext_key");

      assert.equal(await getSecret(altHome), "fw_alt_home_plaintext_key");
    } finally {
      await rm(realHome, { recursive: true, force: true });
      await rm(altHome, { recursive: true, force: true });
    }
  });

  it("setSecret with --home stores in alt home secure backend, not process HOME", async () => {
    const realHome = await mkdtemp(path.join(os.tmpdir(), "fc-real-home-"));
    const altHome = await mkdtemp(path.join(os.tmpdir(), "fc-alt-home-"));
    try {
      delete process.env[KEY_STORAGE_ENV];
      delete process.env.XDG_DATA_HOME;
      resetSecretStoreForTests();
      process.env.HOME = realHome;
      process.env[KEY_STORAGE_ENV] = "file";
      process.env.XDG_DATA_HOME = path.join(realHome, "data");
      process.env.XDG_CONFIG_HOME = path.join(realHome, "cfg");
      await setSecret("fw_real_home_secure_key", realHome);

      process.env.HOME = realHome;
      process.env[KEY_STORAGE_ENV] = "file";
      await setSecret("fw_alt_home_secure_key", altHome);

      assert.equal(await getSecret(realHome), "fw_real_home_secure_key");
      assert.equal(await getSecret(altHome), "fw_alt_home_secure_key");
    } finally {
      await rm(realHome, { recursive: true, force: true });
      await rm(altHome, { recursive: true, force: true });
    }
  });

  it("getSecret falls through stale plaintext cache to secure storage", async () => {
    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    await setSecret("fw_secure_before_cache", home);

    const { writeKeyStorageCache } = await import("../../lib/keys/storage-cache.mjs");
    await writeKeyStorageCache(home, "plaintext");
    await rm(plaintextSecretPath(home), { force: true });

    assert.equal(await getSecret(home), "fw_secure_before_cache");
  });

  it("setSecret falls through stale plaintext cache to secure storage", async () => {
    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    await setSecret("fw_secure_original", home);

    const { writeKeyStorageCache } = await import("../../lib/keys/storage-cache.mjs");
    await writeKeyStorageCache(home, "plaintext");
    await rm(plaintextSecretPath(home), { force: true });

    await setSecret("fw_secure_rotated", home);
    assert.equal(await getSecret(home), "fw_secure_rotated");
    assert.equal(await readKeyStorageCache(home), "file");
  });

  it("setSecret removes orphaned plaintext file when secure storage succeeds", async () => {
    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");

    const plaintextFile = plaintextSecretPath(home);
    assert.ok(plaintextFile);
    await mkdir(path.dirname(plaintextFile), { recursive: true, mode: 0o700 });
    await writeFile(plaintextFile, "fw_orphan_plaintext_key\n", { mode: 0o600 });

    await setSecret("fw_secure_replaces_plaintext", home);
    assert.equal(await getSecret(home), "fw_secure_replaces_plaintext");
    await assert.rejects(() => readFile(plaintextFile, "utf8"), { code: "ENOENT" });
  });

  it("detectSecretBackend ignores stale plaintext cache without a file", async () => {
    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    await setSecret("fw_secure_detect", home);

    const { writeKeyStorageCache } = await import("../../lib/keys/storage-cache.mjs");
    await writeKeyStorageCache(home, "plaintext");
    await rm(plaintextSecretPath(home), { force: true });

    const backend = await detectSecretBackend(home);
    assert.equal(backend.backend, "file");
  });

  it("setSecret migrates off plaintext when secure storage works again", async () => {
    await setSecret("fw_plaintext_first", home);
    assert.equal(await readKeyStorageCache(home), "plaintext");

    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");

    await setSecret("fw_secure_after_plaintext", home);
    assert.equal(await getSecret(home), "fw_secure_after_plaintext");
    assert.equal(await readKeyStorageCache(home), "file");
    await assert.rejects(() => readFile(plaintextSecretPath(home), "utf8"), { code: "ENOENT" });
  });

  it("plaintext fallback clears secure store so old keys cannot resurrect", async () => {
    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    await setSecret("fw_secure_original", home);

    await blockSecureKeyStorage(home);
    await setSecret("fw_plaintext_replacement", home);
    assert.equal(await getSecret(home), "fw_plaintext_replacement");
    assert.equal(await readKeyStorageCache(home), "plaintext");

    await rm(plaintextSecretPath(home), { force: true });
    assert.equal(await getSecret(home), null);
  });

  it("getSecret ignores lingering secure key when plaintext fallback file is missing", async () => {
    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    await setSecret("fw_secure_original", home);

    const { writeKeyStorageCache } = await import("../../lib/keys/storage-cache.mjs");
    await writeKeyStorageCache(
      home,
      "plaintext",
      "simulated fallback after secure deletion failed",
    );

    assert.equal(await getSecret(home), null);
  });

  it("reprobe moves plaintext fallback to secure storage when available", async () => {
    await setSecret("fw_key_migrate_plaintext", home);
    assert.equal(await readKeyStorageCache(home), "plaintext");

    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");

    const result = await reprobeKeyStorage(home);
    assert.equal(result.migrated, true);
    assert.equal(await getSecret(home), "fw_key_migrate_plaintext");
    assert.equal(await readKeyStorageCache(home), "file");
  });

  it("getSecret prefers secure storage when stale plaintext file remains", async () => {
    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");

    await setSecret("fw_new_secure_key", home);
    const plaintextFile = plaintextSecretPath(home);
    assert.ok(plaintextFile);
    await mkdir(path.dirname(plaintextFile), { recursive: true, mode: 0o700 });
    await writeFile(plaintextFile, "fw_stale_plaintext_key\n", { mode: 0o600 });

    assert.equal(await getSecret(home), "fw_new_secure_key");
    assert.equal(await readKeyStorageCache(home), "file");
  });

  it("setSecret rolls back plaintext when key-storage cache persist fails", async () => {
    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    await setSecret("fw_secure_original", home);

    await blockSecureKeyStorage(home);
    const cacheBlocker = path.join(home, ".nexus", "key-storage.json");
    await rm(cacheBlocker, { force: true });
    await mkdir(cacheBlocker, { recursive: true });

    try {
      await assert.rejects(() => setSecret("fw_plaintext_never_committed", home));
      await rm(cacheBlocker, { recursive: true, force: true });
      process.env.XDG_DATA_HOME = path.join(home, "data");
      resetSecretStoreForTests();
      assert.equal(await getSecret(home), "fw_secure_original");
      assert.notEqual(await readPlaintextSecret(home), "fw_plaintext_never_committed");
    } finally {
      await rm(cacheBlocker, { recursive: true, force: true });
    }
  });

  it("reprobeKeyStorage migrates without throwing when plaintext cleanup is best-effort", async () => {
    await setSecret("fw_reprobe_migrate_key", home);
    assert.equal(await readKeyStorageCache(home), "plaintext");

    delete process.env[KEY_STORAGE_ENV];
    delete process.env.XDG_DATA_HOME;
    resetSecretStoreForTests();
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");

    const result = await reprobeKeyStorage(home);
    assert.equal(result.migrated, true);
    assert.equal(await getSecret(home), "fw_reprobe_migrate_key");
    assert.equal(await readKeyStorageCache(home), "file");
  });
});
