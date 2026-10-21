import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  aesDecrypt,
  aesEncrypt,
  decryptSecret,
  encryptSecret,
  linuxEncryptUsesBasicTextBackend,
  linuxDBusSecretServiceHasOwner,
  linuxNativeKeyringAvailable,
  linuxSafeStorageIsObfuscatedFallback,
  linuxSafeStorageObfuscatedKeyNote,
  linuxSecretServiceReachable,
  linuxSecretToolOnPath,
  linuxSecretUsesKeyringBackend,
  loadWindowsOsCryptKey,
  resetLinuxSafeStorageDetectionForTests,
  storedSecretHasCiphertext,
  windowsAesGcmDecrypt,
  windowsAesGcmEncrypt,
} from "../../../lib/harnesses/vscode/safestorage.mjs";

/* -------------------------------------------------------------------------- */
/* OSCrypt cipher wiring (macOS v10 / Linux v10/v11). Deterministic — uses a   */
/* fixed password, so it proves the PBKDF2 + AES-128-CBC + IV + version-prefix */
/* layering is correct and reversible without touching the OS keychain.        */
/* -------------------------------------------------------------------------- */

describe("vscode-safestorage OSCrypt cipher", () => {
  it("round-trips a value through aesEncrypt/aesDecrypt", () => {
    const pw = "peanuts"; // Chromium's Linux basic-backend password
    const blob = aesEncrypt("fw_secret_value_123", pw, "v10");
    assert.equal(blob.subarray(0, 3).toString("latin1"), "v10");
    assert.equal(aesDecrypt(blob, pw), "fw_secret_value_123");
  });

  it("ciphertext is salted/padded, not the plaintext", () => {
    const blob = aesEncrypt("hello", "peanuts", "v11");
    assert.equal(blob.subarray(0, 3).toString("latin1"), "v11");
    assert.ok(!blob.subarray(3).toString("latin1").includes("hello"));
    // AES-CBC with PKCS7 always pads to a full 16-byte block.
    assert.equal((blob.length - 3) % 16, 0);
  });

  it("a wrong password fails to decrypt (does not silently return junk equal to input)", () => {
    const blob = aesEncrypt("topsecret", "peanuts", "v10");
    let decrypted;
    try {
      decrypted = aesDecrypt(blob, "wrongpassword");
    } catch {
      decrypted = undefined; // padding error — acceptable
    }
    assert.notEqual(decrypted, "topsecret");
  });
});

/* -------------------------------------------------------------------------- */
/* Linux OSCrypt prefix + iteration matrix. v11 = keyring (1 iter),            */
/* v10 = basic_text "peanuts" (1 iter). macOS uses v10 + 1003 iters.           */
/* Proves the iteration count actually matters — a 1-iter key cannot decrypt   */
/* a 1003-iter blob and vice versa.                                            */
/* -------------------------------------------------------------------------- */

describe("vscode-safestorage Linux OSCrypt prefix/iteration matrix", () => {
  it("Linux keyring: v11 + 1 iteration round-trips", () => {
    const blob = aesEncrypt("fw_keyring_test", "keyring-master-pw", "v11", 1);
    assert.equal(blob.subarray(0, 3).toString("latin1"), "v11");
    assert.equal(aesDecrypt(blob, "keyring-master-pw", 1), "fw_keyring_test");
  });

  it("Linux basic_text: v10 + 1 iteration + peanuts round-trips", () => {
    const blob = aesEncrypt("fw_basic_test", "peanuts", "v10", 1);
    assert.equal(blob.subarray(0, 3).toString("latin1"), "v10");
    assert.equal(aesDecrypt(blob, "peanuts", 1), "fw_basic_test");
  });

  it("macOS: v10 + 1003 iterations round-trips", () => {
    const blob = aesEncrypt("fw_mac_test", "mac-keychain-pw", "v10", 1003);
    assert.equal(blob.subarray(0, 3).toString("latin1"), "v10");
    assert.equal(aesDecrypt(blob, "mac-keychain-pw", 1003), "fw_mac_test");
  });

  it("1-iteration key does NOT decrypt a 1003-iteration blob (proves iterations matter)", () => {
    const blob = aesEncrypt("fw_iter_guard", "peanuts", "v10", 1003);
    let decrypted;
    try {
      decrypted = aesDecrypt(blob, "peanuts", 1);
    } catch {
      decrypted = undefined;
    }
    assert.notEqual(decrypted, "fw_iter_guard");
  });

  it("1003-iteration key does NOT decrypt a 1-iteration blob", () => {
    const blob = aesEncrypt("fw_iter_guard2", "peanuts", "v10", 1);
    let decrypted;
    try {
      decrypted = aesDecrypt(blob, "peanuts", 1003);
    } catch {
      decrypted = undefined;
    }
    assert.notEqual(decrypted, "fw_iter_guard2");
  });
});

/* -------------------------------------------------------------------------- */
/* Windows OSCrypt: AES-256-GCM with v10 prefix. Layout:                       */
/* v10(3) + nonce(12) + ciphertext + tag(16). Confirmed by ground-truth probe  */
/* against Electron safeStorage on Windows (dev-cloudpos, Electron 42).        */
/* These tests use a fixed 32-byte key and are platform-independent (pure      */
/* crypto).                                                                    */
/* -------------------------------------------------------------------------- */

describe("vscode-safestorage Windows AES-256-GCM", () => {
  const key32 = Buffer.alloc(32, 0xab);

  it("round-trips a value through windowsAesGcmEncrypt/windowsAesGcmDecrypt", () => {
    const blob = windowsAesGcmEncrypt("fw_windows_test_123", key32);
    assert.equal(windowsAesGcmDecrypt(blob, key32), "fw_windows_test_123");
  });

  it("blob has v10 prefix", () => {
    const blob = windowsAesGcmEncrypt("hello", key32);
    assert.equal(blob.subarray(0, 3).toString("latin1"), "v10");
  });

  it("blob layout is v10(3) + nonce(12) + ct + tag(16)", () => {
    const plaintext = "fw_layout_check";
    const blob = windowsAesGcmEncrypt(plaintext, key32);
    const ptLen = Buffer.byteLength(plaintext);
    // GCM is a stream cipher — ciphertext length equals plaintext length (no padding).
    assert.equal(blob.length, 3 + 12 + ptLen + 16);
    // Nonce is the 12 bytes after the v10 prefix.
    const nonce = blob.subarray(3, 15);
    assert.equal(nonce.length, 12);
    // Tag is the last 16 bytes.
    const tag = blob.subarray(blob.length - 16);
    assert.equal(tag.length, 16);
    // Ciphertext is between nonce and tag.
    const ct = blob.subarray(15, blob.length - 16);
    assert.equal(ct.length, ptLen);
    // Ciphertext must not contain the plaintext.
    assert.ok(!ct.toString("latin1").includes(plaintext));
  });

  it("nonce is random (two encryptions of the same plaintext differ after the prefix)", () => {
    const a = windowsAesGcmEncrypt("same-plaintext", key32);
    const b = windowsAesGcmEncrypt("same-plaintext", key32);
    assert.equal(a.subarray(0, 3).toString("latin1"), "v10");
    assert.equal(b.subarray(0, 3).toString("latin1"), "v10");
    // Nonces (bytes 3..15) must differ.
    assert.notDeepEqual(a.subarray(3, 15), b.subarray(3, 15));
    // Both must decrypt to the same plaintext.
    assert.equal(windowsAesGcmDecrypt(a, key32), "same-plaintext");
    assert.equal(windowsAesGcmDecrypt(b, key32), "same-plaintext");
  });

  it("a wrong key fails to decrypt (auth tag mismatch)", () => {
    const blob = windowsAesGcmEncrypt("fw_wrong_key", key32);
    const wrongKey = Buffer.alloc(32, 0xcd);
    assert.throws(() => windowsAesGcmDecrypt(blob, wrongKey), /Unsupported state|unable to authenticate/);
  });

  it("tampering with the ciphertext fails authentication", () => {
    const blob = windowsAesGcmEncrypt("fw_tamper", key32);
    const tampered = Buffer.from(blob);
    tampered[20] ^= 0xff; // flip a bit in the ciphertext region
    assert.throws(() => windowsAesGcmDecrypt(tampered, key32), /Unsupported state|unable to authenticate/);
  });
});

/* -------------------------------------------------------------------------- */
/* Windows Local State key loading. Error paths are platform-independent; the  */
/* happy path requires DPAPI (Windows only) and is skipped elsewhere.          */
/* -------------------------------------------------------------------------- */

describe("vscode-safestorage Windows Local State key loading", () => {
  let tmpDir;

  it("throws a clear error when the Local State file is missing", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fc-localstate-"));
    try {
      const missing = path.join(tmpDir, "Local State");
      assert.throws(
        () => loadWindowsOsCryptKey(missing),
        /Could not read VS Code's "Local State"/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when os_crypt.encrypted_key is absent", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fc-localstate-"));
    try {
      const lsPath = path.join(tmpDir, "Local State");
      writeFileSync(lsPath, JSON.stringify({ some_other_field: true }));
      assert.throws(
        () => loadWindowsOsCryptKey(lsPath),
        /no os_crypt.encrypted_key/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when the encrypted_key prefix is not DPAPI (possible App-Bound Encryption)", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fc-localstate-"));
    try {
      const lsPath = path.join(tmpDir, "Local State");
      const fakeKey = Buffer.concat([
        Buffer.from("APPB?", "latin1"), // wrong prefix
        Buffer.alloc(32, 0x01),
      ]).toString("base64");
      writeFileSync(lsPath, JSON.stringify({ os_crypt: { encrypted_key: fakeKey } }));
      assert.throws(
        () => loadWindowsOsCryptKey(lsPath),
        /unexpected prefix/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when Local State is not valid JSON", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fc-localstate-"));
    try {
      const lsPath = path.join(tmpDir, "Local State");
      writeFileSync(lsPath, "not json {{{");
      assert.throws(
        () => loadWindowsOsCryptKey(lsPath),
        /not valid JSON/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Plaintext test seam (NEXUS_VSCODE_SECRET_PLAINTEXT) used by the        */
/* harness integration tests.                                                  */
/* -------------------------------------------------------------------------- */

describe("vscode-safestorage plaintext seam", () => {
  it("encrypt/decrypt are the identity when the seam is set", () => {
    const prev = process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = "1";
    try {
      assert.equal(encryptSecret("fw_abc"), "fw_abc");
      assert.equal(decryptSecret("fw_abc"), "fw_abc");
    } finally {
      if (prev === undefined) {
        delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
      } else {
        process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = prev;
      }
    }
  });

  it("decryptSecret returns '' for empty/garbage input", () => {
    assert.equal(decryptSecret(""), "");
    assert.equal(decryptSecret("not-json-and-not-plaintext-mode"), "");
  });
});

describe("vscode-safestorage Linux Secret Service detection", () => {
  it("linuxSafeStorageIsObfuscatedFallback is false off Linux", () => {
    if (process.platform === "linux") {
      return;
    }
    resetLinuxSafeStorageDetectionForTests();
    assert.equal(linuxSafeStorageIsObfuscatedFallback(), false);
  });

  it("linuxSecretServiceReachable uses secret-tool or D-Bus only on Linux", () => {
    if (process.platform !== "linux") {
      return;
    }
    resetLinuxSafeStorageDetectionForTests();
    const reachable = linuxSecretServiceReachable();
    const hasProbe = linuxSecretToolOnPath() || linuxDBusSecretServiceHasOwner();
    if (!hasProbe) {
      assert.equal(reachable, false);
      assert.equal(linuxSafeStorageIsObfuscatedFallback(), true);
    } else {
      assert.equal(reachable, true);
      assert.equal(linuxSafeStorageIsObfuscatedFallback(), false);
    }
  });

  it("linuxNativeKeyringAvailable does not imply Secret Service is reachable", () => {
    if (process.platform !== "linux") {
      return;
    }
    resetLinuxSafeStorageDetectionForTests();
    if (!linuxNativeKeyringAvailable()) {
      return;
    }
    if (linuxSecretToolOnPath() || linuxDBusSecretServiceHasOwner()) {
      return;
    }
    assert.equal(linuxSecretServiceReachable(), false);
    assert.equal(linuxSafeStorageIsObfuscatedFallback(), true);
  });

  it("linuxSafeStorageObfuscatedKeyNote mentions secret-tool when a v2 key is decrypt-only reachable", () => {
    if (process.platform !== "linux" || process.env.NEXUS_LIBSECRET_INTEGRATION !== "1") {
      return;
    }
    resetLinuxSafeStorageDetectionForTests();
    if (!linuxSecretServiceReachable() || linuxSecretToolOnPath()) {
      return;
    }
    const note = linuxSafeStorageObfuscatedKeyNote("cursor");
    assert.match(note, /secret-tool/i);
    assert.doesNotMatch(note, /launch Cursor once/i);
  });

  it("linuxSafeStorageObfuscatedKeyNote mentions launch and secret-tool when dbus is up without secret-tool", () => {
    if (process.platform !== "linux" || process.env.NEXUS_LIBSECRET_INTEGRATION === "1") {
      return;
    }
    resetLinuxSafeStorageDetectionForTests();
    if (!linuxSecretServiceReachable() || linuxSecretToolOnPath()) {
      return;
    }
    const note = linuxSafeStorageObfuscatedKeyNote("cursor");
    assert.match(note, /launch Cursor once/i);
    assert.match(note, /libsecret-tools/i);
  });

  it("linuxSafeStorageObfuscatedKeyNote mentions launch when secret-tool is available", () => {
    if (process.platform !== "linux" || !linuxSecretToolOnPath()) {
      return;
    }
    const note = linuxSafeStorageObfuscatedKeyNote("cursor");
    assert.match(note, /launch Cursor once/i);
  });

  it("linuxEncryptUsesBasicTextBackend detects v10 vs v11 prefixes", () => {
    const v10 = JSON.stringify(aesEncrypt("x", "peanuts", "v10", 1));
    const v11 = JSON.stringify(aesEncrypt("x", "keyring-pw", "v11", 1));
    if (process.platform === "linux") {
      assert.equal(linuxEncryptUsesBasicTextBackend(v10), true);
      assert.equal(linuxEncryptUsesBasicTextBackend(v11), false);
    } else {
      assert.equal(linuxEncryptUsesBasicTextBackend(v10), false);
      assert.equal(linuxEncryptUsesBasicTextBackend(v11), false);
    }
  });

  it("linuxSecretUsesKeyringBackend detects v11 only", () => {
    const v10 = JSON.stringify(aesEncrypt("x", "peanuts", "v10", 1));
    const v11 = JSON.stringify(aesEncrypt("x", "keyring-pw", "v11", 1));
    assert.equal(linuxSecretUsesKeyringBackend(v11), process.platform === "linux");
    assert.equal(linuxSecretUsesKeyringBackend(v10), false);
    assert.equal(linuxSecretUsesKeyringBackend(""), false);
    assert.equal(linuxSecretUsesKeyringBackend(null), false);
  });

  it("storedSecretHasCiphertext separates real ciphertext from absent/cleared/garbage rows", () => {
    const prev = process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    try {
      assert.equal(storedSecretHasCiphertext(JSON.stringify(aesEncrypt("x", "pw", "v11", 1))), true);
      assert.equal(storedSecretHasCiphertext(JSON.stringify({ type: "Buffer", data: [] })), false);
      assert.equal(storedSecretHasCiphertext(undefined), false);
      assert.equal(storedSecretHasCiphertext(""), false);
      assert.equal(storedSecretHasCiphertext("not json"), false);
    } finally {
      if (prev === undefined) {
        delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
      } else {
        process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = prev;
      }
    }
  });

  it("encryptSecret on Linux uses v10 when no Safe Storage key is readable", () => {
    if (process.platform !== "linux") {
      return;
    }
    const prev = process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    try {
      const enc = encryptSecret("probe-key", { variant: "cursor" });
      const blob = Buffer.from(JSON.parse(enc).data);
      const prefix = blob.subarray(0, 3).toString("latin1");
      if (prefix === "v11") {
        // A real Cursor Safe Storage key is present on this machine; peanuts fallback
        // cannot be exercised without isolating the session keyring.
        return;
      }
      assert.equal(prefix, "v10");
      assert.equal(linuxEncryptUsesBasicTextBackend(enc), true);
    } finally {
      if (prev === undefined) {
        delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
      } else {
        process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = prev;
      }
    }
  });

  it("encryptSecret on Linux uses v11 when application-scoped key exists (integration)", () => {
    if (process.platform !== "linux" || process.env.NEXUS_LIBSECRET_INTEGRATION !== "1") {
      return;
    }
    const prev = process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    try {
      const enc = encryptSecret("integration-probe", { variant: "cursor" });
      const blob = Buffer.from(JSON.parse(enc).data);
      assert.equal(blob.subarray(0, 3).toString("latin1"), "v11");
      assert.equal(decryptSecret(enc, { variant: "cursor" }), "integration-probe");
      assert.equal(linuxEncryptUsesBasicTextBackend(enc), false);
    } finally {
      if (prev === undefined) {
        delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
      } else {
        process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = prev;
      }
    }
  });
});
