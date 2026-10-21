import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);

/** @type {typeof import("@napi-rs/keyring").Entry | null} */
let NativeKeyringEntry = null;
try {
  NativeKeyringEntry = require("@napi-rs/keyring").Entry;
} catch {
  // Optional; cross-keychain bundles it on Linux.
}

/**
 * Electron `safeStorage`-compatible secret encryption.
 *
 * VS Code Chat's BYOK secrets (the `customendpoint` `apiKey`) are NOT stored as
 * a per-secret OS keychain entry. `LanguageModelsService` resolves the
 * `${input:chat.lm.secret.<id>}` reference via `ISecretStorageService.get(<id>)`,
 * which reads an **encrypted blob from the application-scoped `state.vscdb`**
 * (`ItemTable`, key `secret://<id>`) and decrypts it with Electron `safeStorage`
 * (see VS Code's `BaseSecretStorageService` + `EncryptionMainService`).
 *
 * The value stored in `state.vscdb` is exactly
 * `JSON.stringify(safeStorage.encryptString(plaintext))`, i.e. the JSON form of a
 * Node Buffer — `{"type":"Buffer","data":[...]}` — whose bytes are the platform
 * `safeStorage` ciphertext. This module reproduces that ciphertext so the harness
 * can write a key VS Code can actually read.
 *
 * Platform schemes (matching Chromium's OSCrypt, which Electron `safeStorage`
 * wraps — verified against Chromium's `os_crypt/async/common/algorithm.mojom`
 * and `encryptor.cc`):
 * - macOS:   `v10` + AES-128-CBC. Key = PBKDF2-HMAC-SHA1(masterPw, "saltysalt",
 *            1003, 16). IV = 16×0x20. The master password is a random value in
 *            the login keychain under service "<AppName> Safe Storage".
 * - Windows: `v10` + AES-256-GCM. Layout: `v10(3) + nonce(12) + ciphertext +
 *            tag(16)`. The 32-byte key is DPAPI-protected
 *            (`CryptProtectData`, CurrentUser) and stored base64-encoded under
 *            `os_crypt.encrypted_key` in the `Local State` JSON file (with a
 *            5-byte `"DPAPI"` prefix before the protected blob).
 * - Linux:   `v11` + AES-128-CBC with **1** PBKDF2 iteration when a keyring
 *            (libsecret) holds the master password, else `v10` with the
 *            hardcoded "peanuts" password (the "basic_text" backend) — also
 *            1 iteration. Same KDF/cipher as macOS but with 1 iteration, not
 *            1003 (which is macOS-only).
 *
 * Test seam: when NEXUS_VSCODE_SECRET_PLAINTEXT is set, encrypt/decrypt are
 * the identity (the raw key is stored verbatim). VS Code does NOT read such a
 * value — this is only for exercising the harness's logic headlessly/in CI.
 */

const SALT = "saltysalt";
const MAC_ITERATIONS = 1003;
const LINUX_ITERATIONS = 1;
const KEY_LEN = 16;
const IV = Buffer.alloc(16, 0x20);
const LINUX_BASIC_PASSWORD = "peanuts";

/**
 * The JSON form of an empty Node Buffer — `JSON.stringify(Buffer.alloc(0))`.
 * This is what `safeStorage.encryptString("")` serializes to, and what
 * VS Code/Cursor leave in a `secret://` cell when the user clears a key in the
 * IDE. Treated as "no secret" by {@link decryptSecret}.
 */
const EMPTY_BUFFER_JSON = JSON.stringify({ type: "Buffer", data: [] });

/* Windows (Chromium OSCrypt async — AES-256-GCM with a DPAPI-protected key). */
const WIN_VERSION = "v10";
const WIN_NONCE_LEN = 12;
const WIN_TAG_LEN = 16;
const WIN_KEY_LEN = 32;
const DPAPI_PREFIX = "DPAPI";

/**
 * @returns {boolean} whether the plaintext test seam is active.
 * Strictly `=== "1"` so that `NEXUS_VSCODE_SECRET_PLAINTEXT=0` (or any
 * other value) does NOT enable plaintext — a common footgun with truthy-string
 * env checks. Exported for unit tests.
 */
export function plaintextMode() {
  return process.env.NEXUS_VSCODE_SECRET_PLAINTEXT === "1";
}

/** Memoized result of {@link linuxSecretServiceReachable} (process-constant). */
let secretServiceReachableMemo;

/**
 * Reset memoized Linux Secret Service probes (tests only).
 */
export function resetLinuxSafeStorageDetectionForTests() {
  secretServiceReachableMemo = undefined;
}

/**
 * Whether `secret-tool` (libsecret-tools) is on PATH.
 * Ubuntu's `libsecret-tools` does not implement `--version`; a missing binary
 * sets `error` on spawn, while a present binary exits non-zero without args.
 * @returns {boolean}
 */
export function linuxSecretToolOnPath() {
  try {
    const r = spawnSync("secret-tool", [], { encoding: "utf8", stdio: "ignore" });
    return !r.error;
  } catch {
    return false;
  }
}

/**
 * Whether the session D-Bus has an owner for org.freedesktop.secrets.
 * @returns {boolean}
 */
export function linuxDBusSecretServiceHasOwner() {
  try {
    const res = spawnSync(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.NameHasOwner",
        "string:org.freedesktop.secrets",
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    if (res.error || res.status !== 0) {
      return false;
    }
    return /boolean\s+true/.test(res.stdout || "");
  } catch {
    return false;
  }
}

/**
 * Whether @napi-rs/keyring native bindings are loadable. Used only as a
 * fallback for reading an app's Safe Storage master password when
 * `secret-tool` is absent — NOT as a signal that Secret Service is reachable.
 * @returns {boolean}
 */
export function linuxNativeKeyringAvailable() {
  return NativeKeyringEntry !== null;
}

/**
 * Best-effort probe for a reachable Freedesktop Secret Service on Linux.
 * Requires `secret-tool` on PATH and/or a session D-Bus owner for
 * `org.freedesktop.secrets`. Loading @napi-rs/keyring alone does not count.
 * @returns {boolean}
 */
export function linuxSecretServiceReachable() {
  if (secretServiceReachableMemo !== undefined) {
    return secretServiceReachableMemo;
  }
  if (process.platform !== "linux") {
    secretServiceReachableMemo = false;
    return false;
  }
  secretServiceReachableMemo = linuxSecretToolOnPath()
    || linuxDBusSecretServiceHasOwner();
  return secretServiceReachableMemo;
}

/**
 * User-facing note when Linux safeStorage wrote a v10/peanuts blob.
 * @param {"stable" | "insiders" | "cursor"} [variant]
 * @returns {string}
 */
export function linuxSafeStorageObfuscatedKeyNote(variant) {
  const app = variant === "cursor"
    ? "Cursor"
    : variant === "insiders"
      ? "VS Code Insiders"
      : "VS Code";
  const harnessCmd = variant === "cursor" ? "nexus cursor" : "nexus vscode";
  // encryptSecret uses secret-tool only (forEncrypt). When dbus is up but
  // secret-tool is absent, peanuts/v10 is still written. Only recommend
  // libsecret-tools when a v2 password is already present (python can see it);
  // otherwise the IDE likely has not created its Safe Storage entry yet.
  if (linuxSecretServiceReachable() && !linuxSecretToolOnPath()) {
    for (const application of linuxApplicationNameCandidates(variant)) {
      if (linuxPythonOsCryptV2PasswordLookup(application)) {
        return (
          `Note: Secret Service is available but Nexus could not encrypt ${app}'s API key without \`secret-tool\` `
          + "(install libsecret-tools). "
          + `The API key was stored obfuscated for now. Re-run \`${harnessCmd}\` after installing \`secret-tool\` for real encryption.`
        );
      }
    }
    return (
      `Note: ${app}'s Safe Storage key is not in the keyring yet (launch ${app} once so it creates one), `
      + "and Nexus also needs `secret-tool` from libsecret-tools to encrypt on Linux. "
      + `The API key was stored obfuscated for now. Re-run \`${harnessCmd}\` after launching ${app} and installing libsecret-tools for real encryption.`
    );
  }
  return (
    `Note: ${app}'s Safe Storage key is not in the keyring yet (launch ${app} once so it creates one), `
    + `so the API key was stored obfuscated for now. Re-run \`${harnessCmd}\` after launching ${app} for real encryption.`
  );
}

/**
 * On Linux, Electron `safeStorage` (and thus VS Code/Cursor) only encrypts when
 * a Secret Service implementation (libsecret/gnome-keyring/kwallet) is available
 * to hold the master password. Without it, Chromium falls back to the
 * hardcoded "peanuts" password — i.e. the stored secret is **obfuscated, not
 * encrypted**. Detect that so we can warn the user.
 *
 * Returns false on macOS/Windows (real OS keychain always available) and when
 * a Secret Service appears to be present on Linux. Memoized because platform
 * and Secret Service availability do not change mid-process and this is called
 * 2-4 times per on/status run.
 *
 * Note: this is independent of Nexus's own key storage backend
 * (`nexus status` → cross-keychain). Both may use libsecret, but they
 * store different secrets.
 * @returns {boolean}
 */
export function linuxSafeStorageIsObfuscatedFallback() {
  if (process.platform !== "linux") {
    return false;
  }
  return !linuxSecretServiceReachable();
}

/**
 * Whether a Linux safeStorage ciphertext JSON blob was produced with the
 * basic_text ("peanuts") backend (v10) rather than a keyring master password (v11).
 * @param {string} encryptedJson
 * @returns {boolean}
 */
export function linuxEncryptUsesBasicTextBackend(encryptedJson) {
  return linuxCiphertextVersion(encryptedJson) === "v10";
}

/**
 * Whether a Linux safeStorage ciphertext JSON blob was encrypted with a keyring
 * master password (v11) rather than the basic_text ("peanuts") backend (v10).
 * @param {string} encryptedJson
 * @returns {boolean}
 */
export function linuxSecretUsesKeyringBackend(encryptedJson) {
  return linuxCiphertextVersion(encryptedJson) === "v11";
}

/**
 * @param {string} encryptedJson
 * @returns {string} the 3-byte OSCrypt version prefix on Linux, else "".
 */
function linuxCiphertextVersion(encryptedJson) {
  if (process.platform !== "linux" || plaintextMode()) {
    return "";
  }
  try {
    const parsed = JSON.parse(encryptedJson);
    if (!parsed || !Array.isArray(parsed.data)) {
      return "";
    }
    const blob = Buffer.from(parsed.data);
    return blob.length >= 3 ? blob.subarray(0, 3).toString("latin1") : "";
  } catch {
    return "";
  }
}

/**
 * Whether a `state.vscdb` secret value holds real ciphertext — i.e. it is not
 * absent, not the empty-buffer "cleared" marker, and not unparseable garbage.
 * Lets callers tell "nothing stored" apart from "stored but undecryptable",
 * since {@link decryptSecret} returns "" for both.
 * @param {string | null | undefined} stored
 * @returns {boolean}
 */
export function storedSecretHasCiphertext(stored) {
  if (!stored || stored === EMPTY_BUFFER_JSON) {
    return false;
  }
  if (plaintextMode()) {
    return true;
  }
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed?.data) && parsed.data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Electron app name for the variant. Stable VS Code's keychain item is
 * "Code Safe Storage"; Insiders is "Code - Insiders Safe Storage".
 * @param {"stable" | "insiders"} [variant]
 * @returns {string}
 */
function appNameFor(variant) {
  if (variant === "insiders") {
    return "Code - Insiders";
  }
  if (variant === "cursor") {
    return "Cursor";
  }
  return "Code";
}

/* -------------------------------------------------------------------------- */
/* OSCrypt AES (macOS + Linux)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Derive the AES-128 key from a master password (Chromium OSCrypt KDF).
 * @param {string} masterPassword @param {number} iterations
 */
function deriveKey(masterPassword, iterations) {
  return crypto.pbkdf2Sync(masterPassword, SALT, iterations, KEY_LEN, "sha1");
}

/**
 * Chromium OSCrypt AES encryption (macOS `v10`, Linux `v10`/`v11`). Exported for
 * unit tests; production callers go through {@link encryptSecret}.
 * @param {string} plaintext @param {string} masterPassword @param {string} version
 * @param {number} [iterations=MAC_ITERATIONS]
 */
export function aesEncrypt(plaintext, masterPassword, version, iterations = MAC_ITERATIONS) {
  const key = deriveKey(masterPassword, iterations);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(version, "latin1"), body]);
}

/**
 * Chromium OSCrypt AES decryption (inverse of {@link aesEncrypt}). Exported for
 * unit tests; production callers go through {@link decryptSecret}.
 * @param {Buffer} blob @param {string} masterPassword
 * @param {number} [iterations=MAC_ITERATIONS]
 */
export function aesDecrypt(blob, masterPassword, iterations = MAC_ITERATIONS) {
  const key = deriveKey(masterPassword, iterations);
  const body = blob.subarray(3); // strip the 3-byte "vNN" version prefix
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/* -------------------------------------------------------------------------- */
/* macOS — master password from the login keychain                            */
/* -------------------------------------------------------------------------- */

/**
 * Per-process cache of macOS Safe Storage master passwords. Each lookup runs
 * `security find-generic-password`, which can show a Keychain prompt; macOS
 * "Allow" is one-shot, so cursor/vscode `on` (decrypt + encrypt + availability
 * checks) used to re-prompt until the user chose "Always Allow".
 * @type {Map<string, string>}
 */
const macMasterPasswordCache = new Map();

/** Test seam: clear cached macOS Safe Storage master passwords. */
export function resetMacMasterPasswordCacheForTests() {
  macMasterPasswordCache.clear();
}

/**
 * Read the Safe Storage master password from the macOS login keychain.
 * @param {"stable" | "insiders" | "cursor"} [variant]
 * @returns {string} the password, or "" if not found.
 */
function macReadMasterPassword(variant) {
  const cacheKey = variant ?? "stable";
  if (macMasterPasswordCache.has(cacheKey)) {
    return macMasterPasswordCache.get(cacheKey) ?? "";
  }
  const service = `${appNameFor(variant)} Safe Storage`;
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return "";
  }
  const password = (r.stdout || "").replace(/\n$/, "");
  macMasterPasswordCache.set(cacheKey, password);
  return password;
}

/* -------------------------------------------------------------------------- */
/* Linux — master password from libsecret, else "peanuts" (basic backend)      */
/* -------------------------------------------------------------------------- */

/** Chromium OSCrypt v2 libsecret collection schema. */
export const LINUX_OSCRYPT_V2_SCHEMA = "chrome_libsecret_os_crypt_password_v2";

const PYTHON_OSCRYPT_V2_LOOKUP = [
  "import os, sys",
  "app = os.environ.get('FC_OSCRYPT_APPLICATION', '')",
  "schema = os.environ.get('FC_OSCRYPT_SCHEMA', '')",
  "if not app or not schema:",
  "    raise SystemExit(0)",
  "try:",
  "    import secretstorage",
  "except ImportError:",
  "    raise SystemExit(0)",
  "bus = secretstorage.dbus_init()",
  "coll = secretstorage.get_default_collection(bus)",
  "items = list(coll.search_items({'xdg:schema': schema, 'application': app}))",
  "sys.stdout.write(items[0].get_secret().decode() if items else '')",
].join("\n");

/**
 * @param {string[]} attrs flat attribute pairs for `secret-tool lookup`
 * @returns {string}
 */
function linuxSecretToolLookup(attrs) {
  if (!linuxSecretToolOnPath()) {
    return "";
  }
  const r = spawnSync("secret-tool", ["lookup", ...attrs], { encoding: "utf8" });
  if (r.status === 0 && (r.stdout || "").length > 0) {
    return r.stdout.replace(/\n$/, "");
  }
  return "";
}

/**
 * Read the Chromium v2 OSCrypt master password scoped to the documented
 * libsecret schema plus an `application` attribute (e.g. `code`, `cursor`).
 * @param {string} application
 * @returns {string}
 */
function linuxOsCryptV2PasswordLookup(application) {
  return linuxSecretToolLookup([
    "xdg:schema", LINUX_OSCRYPT_V2_SCHEMA,
    "application", application,
  ]);
}

/**
 * D-Bus/libsecret fallback when `secret-tool` is absent but Secret Service is
 * reachable (e.g. python3-secretstorage installed). Uses the same v2 schema.
 * @param {string} application
 * @returns {string}
 */
function linuxPythonOsCryptV2PasswordLookup(application) {
  if (!linuxDBusSecretServiceHasOwner()) {
    return "";
  }
  const r = spawnSync("python3", ["-c", PYTHON_OSCRYPT_V2_LOOKUP], {
    encoding: "utf8",
    env: {
      ...process.env,
      FC_OSCRYPT_APPLICATION: application,
      FC_OSCRYPT_SCHEMA: LINUX_OSCRYPT_V2_SCHEMA,
    },
  });
  if (r.status === 0 && (r.stdout || "").length > 0) {
    return r.stdout.replace(/\n$/, "");
  }
  return "";
}

/**
 * @param {string} service @param {string} account
 * @returns {string}
 */
function linuxNativeKeyringLookup(service, account) {
  if (!NativeKeyringEntry) {
    return "";
  }
  try {
    const entry = new NativeKeyringEntry(service, account);
    const pw = entry.getPassword();
    return pw ?? "";
  } catch {
    return "";
  }
}

/**
 * Chromium v2 libsecret schema (`chrome_libsecret_os_crypt_password_v2`) stores the
 * OSCrypt master password under an `application` attribute (e.g. `code`, `cursor`).
 * Legacy entries use service/account instead. Try both, scoped to this app only.
 * @param {"stable" | "insiders" | "cursor"} variant
 * @returns {string[]}
 */
function linuxApplicationNameCandidates(variant) {
  const app = appNameFor(variant);
  const candidates = [app.toLowerCase(), app];
  if (variant === "insiders") {
    candidates.push("code-insiders");
  }
  return [...new Set(candidates)];
}

/**
 * Try to read the Safe Storage master password from the Linux keyring. Chromium
 * stores it under libsecret with an `application` attribute (v2 schema) and/or
 * a legacy "<App> Safe Storage" service + account pair. On failure callers fall
 * back to the basic backend.
 * @param {"stable" | "insiders" | "cursor"} [variant]
 * @param {{ forEncrypt?: boolean }} [opts]
 *   When `forEncrypt` is true, only use `secret-tool` lookup paths. Python3
 *   secretstorage and `@napi-rs/keyring` are decrypt-only fallbacks: they can
 *   return stale legacy passwords or v2 keys Electron would not use for encrypt.
 * @returns {string} the password, or "" when no keyring entry is found.
 */
function linuxReadMasterPassword(variant, { forEncrypt = false } = {}) {
  const app = appNameFor(variant);
  const service = `${app} Safe Storage`;
  for (const application of linuxApplicationNameCandidates(variant)) {
    const appPw = linuxOsCryptV2PasswordLookup(application)
      || (forEncrypt ? "" : linuxPythonOsCryptV2PasswordLookup(application));
    if (appPw) {
      return appPw;
    }
  }
  const pw = linuxSecretToolLookup(["service", service, "account", app]);
  if (pw) {
    return pw;
  }
  if (forEncrypt) {
    return "";
  }
  for (const account of [app, app.toLowerCase()]) {
    const nativePw = linuxNativeKeyringLookup(service, account);
    if (nativePw) {
      return nativePw;
    }
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* Windows — DPAPI via PowerShell (ProtectedData, CurrentUser)                 */
/* -------------------------------------------------------------------------- */

/**
 * Run a PowerShell snippet that prints a single base64 line, or "" on failure.
 * @param {string} script
 * @returns {string}
 */
function runPowerShell(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return "";
  }
  return (r.stdout || "").replace(/\r?\n/g, "").trim();
}

/**
 * DPAPI-protect a raw byte buffer (buffer-based to preserve binary data).
 * The previous string-based round-trip corrupted 32-byte keys because it
 * routed raw bytes through a UTF-8 string (yielding 45 bytes for a 32-byte
 * key with high-bit bytes). This function never touches a text encoding.
 * @param {Buffer} buf
 * @returns {Buffer} DPAPI-protected bytes (empty on failure).
 */
function windowsProtectBuffer(buf) {
  const b64 = buf.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    "$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($enc)",
  ].join(";");
  const out = runPowerShell(script);
  return out ? Buffer.from(out, "base64") : Buffer.alloc(0);
}

/**
 * DPAPI-unprotect a raw byte buffer (buffer-based to preserve binary data).
 * Returns the exact bytes DPAPI produces — no UTF-8 conversion — so 32-byte
 * AES-256 keys survive the round-trip.
 * @param {Buffer} blob
 * @returns {Buffer} the decrypted bytes (empty on failure).
 */
function windowsUnprotectBuffer(blob) {
  const b64 = blob.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    "$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($dec)",
  ].join(";");
  const out = runPowerShell(script);
  return out ? Buffer.from(out, "base64") : Buffer.alloc(0);
}

/** @param {string} plaintext @returns {Buffer} DPAPI-protected bytes (empty on failure). */
function windowsProtect(plaintext) {
  return windowsProtectBuffer(Buffer.from(plaintext, "utf8"));
}

/** @param {Buffer} blob @returns {string} the decrypted plaintext (empty on failure). */
function windowsUnprotect(blob) {
  const buf = windowsUnprotectBuffer(blob);
  return buf.length > 0 ? buf.toString("utf8") : "";
}

/* -------------------------------------------------------------------------- */
/* Windows — AES-256-GCM with a DPAPI-protected key from `Local State`         */
/* -------------------------------------------------------------------------- */

/**
 * Read the Chromium/Electron `os_crypt` master key from VS Code's `Local State`
 * JSON file. The key is base64-encoded under `os_crypt.encrypted_key`, prefixed
 * with a 5-byte `"DPAPI"` marker, then DPAPI-protected (CurrentUser). This
 * function loads, decodes, and DPAPI-unprotects it to a raw 32-byte AES-256 key.
 *
 * @param {string} localStatePath absolute path to VS Code's `Local State` file
 * @returns {Buffer} the 32-byte AES-256-GCM key
 * @throws {Error} if the file is missing, the key field is absent, or DPAPI
 *   unprotection fails or yields a wrong-length key.
 */
export function loadWindowsOsCryptKey(localStatePath) {
  let raw;
  try {
    raw = readFileSync(localStatePath, "utf8");
  } catch {
    throw new Error(
      `Could not read VS Code's "Local State" file at ${localStatePath}. Open VS Code once (it creates the OSCrypt key on first launch) and retry.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`VS Code's "Local State" file at ${localStatePath} is not valid JSON.`);
  }
  const encKeyB64 = parsed?.os_crypt?.encrypted_key;
  if (!encKeyB64 || typeof encKeyB64 !== "string") {
    throw new Error(
      `VS Code's "Local State" file at ${localStatePath} has no os_crypt.encrypted_key. Open VS Code once and retry.`,
    );
  }
  const encKey = Buffer.from(encKeyB64, "base64");
  if (encKey.subarray(0, DPAPI_PREFIX.length).toString("latin1") !== DPAPI_PREFIX) {
    // If the prefix is not "DPAPI", this may be App-Bound Encryption (v20),
    // which uses an app-identity DPAPI layer that an external process cannot
    // replicate. Fail clearly rather than producing a corrupt key.
    throw new Error(
      `VS Code's OSCrypt key in "Local State" has an unexpected prefix "${encKey.subarray(0, 5).toString("latin1")}" (expected "DPAPI"). App-Bound Encryption may be enabled; this is not yet supported.`,
    );
  }
  const dpapiBlob = encKey.subarray(DPAPI_PREFIX.length);
  const key = windowsUnprotectBuffer(dpapiBlob);
  if (key.length !== WIN_KEY_LEN) {
    throw new Error(
      `DPAPI-unprotected OSCrypt key from "Local State" is ${key.length} bytes, expected ${WIN_KEY_LEN}.`,
    );
  }
  return key;
}

/**
 * Chromium OSCrypt Windows encryption: `v10` + AES-256-GCM.
 * Layout: `v10(3) + nonce(12) + ciphertext + tag(16)` (tag at the end,
 * confirmed by ground-truth probe against Electron safeStorage on Windows).
 * @param {string} plaintext @param {Buffer} key32 the 32-byte AES-256 key
 * @returns {Buffer}
 */
export function windowsAesGcmEncrypt(plaintext, key32) {
  const nonce = crypto.randomBytes(WIN_NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key32, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(WIN_VERSION, "latin1"), nonce, ciphertext, tag]);
}

/**
 * Chromium OSCrypt Windows decryption (inverse of {@link windowsAesGcmEncrypt}).
 * @param {Buffer} blob @param {Buffer} key32
 * @returns {string}
 */
export function windowsAesGcmDecrypt(blob, key32) {
  const nonce = blob.subarray(WIN_VERSION.length, WIN_VERSION.length + WIN_NONCE_LEN);
  const tag = blob.subarray(blob.length - WIN_TAG_LEN);
  const ciphertext = blob.subarray(
    WIN_VERSION.length + WIN_NONCE_LEN,
    blob.length - WIN_TAG_LEN,
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", key32, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Encrypt a secret into the exact string VS Code stores in `state.vscdb`
 * (`JSON.stringify(safeStorage.encryptString(value))`).
 * @param {string} plaintext
 * @param {{ variant?: "stable" | "insiders", localStatePath?: string }} [opts]
 *   `localStatePath` is required on Windows (path to VS Code's `Local State`
 *   file, which holds the DPAPI-protected AES-256 key).
 * @returns {string}
 */
export function encryptSecret(plaintext, { variant, localStatePath } = {}) {
  if (plaintextMode()) {
    return plaintext;
  }
  const platform = os.platform();
  if (platform === "darwin") {
    const pw = macReadMasterPassword(variant);
    if (!pw) {
      throw new Error(secretEncryptionUnavailableMessage(variant));
    }
    return JSON.stringify(aesEncrypt(plaintext, pw, "v10", MAC_ITERATIONS));
  }
  if (platform === "win32") {
    const key32 = loadWindowsOsCryptKey(localStatePath);
    const enc = windowsAesGcmEncrypt(plaintext, key32);
    return JSON.stringify(enc);
  }
  // linux / others
  const keyringPw = linuxReadMasterPassword(variant, { forEncrypt: true });
  if (keyringPw) {
    // Chromium OSCrypt Linux with a keyring: v11 + 1 PBKDF2 iteration.
    return JSON.stringify(aesEncrypt(plaintext, keyringPw, "v11", LINUX_ITERATIONS));
  }
  // basic_text backend (no keyring): v10 + hardcoded "peanuts" password, 1 iteration.
  return JSON.stringify(aesEncrypt(plaintext, LINUX_BASIC_PASSWORD, "v10", LINUX_ITERATIONS));
}

/**
 * Decrypt a value read from `state.vscdb` (the JSON form of the safeStorage
 * ciphertext) back to plaintext. Returns "" when it can't be decrypted.
 * @param {string} stored
 * @param {{ variant?: "stable" | "insiders", localStatePath?: string }} [opts]
 *   `localStatePath` is required on Windows (path to VS Code's `Local State`
 *   file, which holds the DPAPI-protected AES-256 key).
 * @returns {string}
 */
export function decryptSecret(stored, { variant, localStatePath } = {}) {
  if (stored === "" || stored == null) {
    return "";
  }
  if (plaintextMode()) {
    // The empty-buffer marker (`{"type":"Buffer","data":[]}`) is the encrypted
    // form of "" in real mode; treat it as "" here too, so an IDE-cleared key
    // decrypts to "no key" the same way under the plaintext seam.
    return stored === EMPTY_BUFFER_JSON ? "" : stored;
  }
  let blob;
  try {
    const parsed = JSON.parse(stored);
    if (!parsed || !Array.isArray(parsed.data)) {
      return "";
    }
    blob = Buffer.from(parsed.data);
  } catch {
    return "";
  }
  // An empty ciphertext is the "no key" shape VS Code/Cursor write when the user
  // clears a key in the IDE — there's nothing to decrypt.
  if (blob.length === 0) {
    return "";
  }
  try {
    const platform = os.platform();
    if (platform === "win32") {
      const key32 = loadWindowsOsCryptKey(localStatePath);
      return windowsAesGcmDecrypt(blob, key32);
    }
    const version = blob.subarray(0, 3).toString("latin1");
    let pw;
    let iterations;
    if (platform === "darwin") {
      pw = macReadMasterPassword(variant);
      iterations = MAC_ITERATIONS;
    } else if (version === "v11") {
      // Linux keyring: v11 + keyring master password + 1 iteration.
      pw = linuxReadMasterPassword(variant);
      iterations = LINUX_ITERATIONS;
    } else {
      // Linux basic_text: v10 + "peanuts" + 1 iteration.
      pw = LINUX_BASIC_PASSWORD;
      iterations = LINUX_ITERATIONS;
    }
    if (!pw) {
      return "";
    }
    return aesDecrypt(blob, pw, iterations);
  } catch {
    return "";
  }
}

/**
 * Whether the harness can produce a blob VS Code will decrypt on this machine.
 * @param {{ variant?: "stable" | "insiders", localStatePath?: string }} [opts]
 * @returns {boolean}
 */
export function isSecretEncryptionAvailable({ variant, localStatePath } = {}) {
  if (plaintextMode()) {
    return true;
  }
  const platform = os.platform();
  if (platform === "darwin") {
    return macReadMasterPassword(variant).length > 0;
  }
  if (platform === "win32") {
    // Require a readable Local State with a loadable OSCrypt key. If the key
    // is missing VS Code hasn't launched yet — `on` should fail with the
    // actionable "open VS Code once" message rather than failing mid-encrypt.
    try {
      loadWindowsOsCryptKey(localStatePath);
      return true;
    } catch {
      return false;
    }
  }
  // linux: the basic_text backend always works ("peanuts"); a keyring is a bonus.
  return true;
}

/**
 * @param {"stable" | "insiders" | "cursor"} [variant]
 * @returns {string}
 */
export function secretEncryptionUnavailableMessage(variant) {
  const app = appNameFor(variant);
  const platform = os.platform();
  if (platform === "darwin") {
    return `Could not read ${app}'s "${app} Safe Storage" key from the login Keychain, so the API key can't be stored where ${app} reads it. Open ${app} once (it creates this key on first launch) and retry.`;
  }
  if (platform === "win32") {
    return `Could not load ${app}'s OSCrypt encryption key from its "Local State" file. Open ${app} once (it creates this key on first launch) and retry.`;
  }
  return `Could not encrypt the ${app} API key for ${app}'s secret storage.`;
}
