import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

const SECRET_STORE = new URL("../../lib/keys/secret-store.mjs", import.meta.url).href;
const FAKE_KEYCHAIN = new URL("./fixtures/fake-cross-keychain.mjs", import.meta.url).href;
const USE_FAKE = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(FAKE_KEYCHAIN)});`;

/** Run `code` as its own process (a separate CLI command) against the fake keychain. */
function run(home, keychain, code) {
  const env = { ...process.env, HOME: home, FAKE_KEYCHAIN: keychain };
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "NEXUS_KEY_STORAGE", "NEXUS_SECRET_STORE", "NEXUS_TEST", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT", "KEYRING_FILE_MASTER_KEY"]) {
    delete env[key];
  }
  const result = spawnSync(process.execPath, [
    "--import", USE_FAKE, "--input-type=module", "-e",
    `const s = await import(${JSON.stringify(SECRET_STORE)}); const home = process.env.HOME; ${code}`,
  ], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const readKey = (home, keychain) => run(home, keychain, "console.log(String(await s.getSecret(home)));");

describe("an OS keychain that refuses the key", () => {
  it("keeps reading it from the encrypted file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nexus-file-fallback-"));
    try {
      run(home, "broken", "await s.setSecret('fw_key', home);");
      assert.equal(readKey(home, "broken"), "fw_key");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("deleteSecret removes both copies so a deleted key cannot resurrect", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nexus-file-fallback-delete-"));
    try {
      // Keychain copy first, then a broken-keychain write that falls back to
      // the encrypted file: both stores now hold the key, cache says file.
      run(home, "working", "await s.setSecret('fw_old', home);");
      run(home, "broken", "await s.setSecret('fw_old', home);");
      run(home, "working", "await s.deleteSecret(home);");
      assert.equal(readKey(home, "working"), "null");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("moves it into the keychain on upgrade only once the keychain keeps it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nexus-file-fallback-reprobe-"));
    try {
      run(home, "broken", "await s.setSecret('fw_key', home);");
      run(home, "forgetful", "await s.reprobeKeyStorage(home);");
      assert.equal(readKey(home, "forgetful"), "fw_key");
      run(home, "working", "await s.reprobeKeyStorage(home);");
      assert.equal(readKey(home, "working"), "fw_key");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
