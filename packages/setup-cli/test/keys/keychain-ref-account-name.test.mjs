import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  resolveStoredApiKey,
} from "../../lib/config/global-config.mjs";
import {
  isKeychainConfigRef,
  resolveStoredApiKeyValue,
} from "../../lib/keys/api-key.mjs";
import { SECRET_ACCOUNT, resetSecretStoreForTests, setSecret } from "../../lib/keys/secret-store.mjs";

/**
 * Run `fn` with the in-memory secret store active under a throwaway HOME.
 * Mirrors the pattern in secret-store.test.mjs.
 */
async function withMemoryStore(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-keychain-ref-"));
  const prev = {
    home: process.env.HOME,
    store: process.env.NEXUS_SECRET_STORE,
    test: process.env.NEXUS_TEST,
    fwKey: process.env.FIREWORKS_API_KEY,
  };
  process.env.HOME = home;
  process.env.NEXUS_SECRET_STORE = "memory";
  process.env.NEXUS_TEST = "1";
  delete process.env.FIREWORKS_API_KEY;
  resetSecretStoreForTests();
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of [
      ["HOME", prev.home],
      ["NEXUS_SECRET_STORE", prev.store],
      ["NEXUS_TEST", prev.test],
      ["FIREWORKS_API_KEY", prev.fwKey],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
  }
}

describe("keychain config ref names the account", () => {
  it("canonical ref matches the keychain account name (drift guard)", () => {
    assert.equal(FIREWORKS_API_KEY_KEYCHAIN_REF, `{keychain:${SECRET_ACCOUNT}}`);
    assert.equal(FIREWORKS_API_KEY_KEYCHAIN_REF, "{keychain:fireworks-api-key}");
  });

  it("recognizes the keychain ref and rejects other values", () => {
    assert.equal(isKeychainConfigRef(FIREWORKS_API_KEY_KEYCHAIN_REF), true);
    assert.equal(isKeychainConfigRef("{env:FIREWORKS_API_KEY}"), false);
    assert.equal(isKeychainConfigRef("fw_literal_key_123"), false);
    // The sync resolver never surfaces the sentinel as if it were a key.
    assert.equal(resolveStoredApiKey(FIREWORKS_API_KEY_KEYCHAIN_REF), "");
  });

  it("resolves the stored key from a config that uses the keychain ref", async () => {
    await withMemoryStore(async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await writeFile(
        path.join(home, ".nexus", "config.json"),
        JSON.stringify({ apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF, harnesses: {} }),
      );
      await setSecret("fw_stored_key_123", home);

      assert.equal(
        await resolveStoredApiKeyValue(FIREWORKS_API_KEY_KEYCHAIN_REF, home),
        "fw_stored_key_123",
      );
    });
  });
});
