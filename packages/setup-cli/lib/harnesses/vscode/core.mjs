import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultMainModel,
  firerouterRequiresAnthropicKey,
  isAutoModelId,
  isAutoInstantModelId,
  isFirerouterModelPattern,
  fullFireworksResourceId,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { resolveModelDisplayMetadata } from "../../fireworks/model-display.mjs";
import { planCatalogRefresh } from "../../harness/catalog-refresh.mjs";
import { autoDisplayName, firerouterDisplayName, prettyModelName } from "../../fireworks/models.mjs";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  DEFAULT_AZURE_MODEL,
  MISSING_AZURE_API_KEY_MESSAGE,
  MISSING_AZURE_BASE_URL_MESSAGE,
  normalizeAzureBaseUrl,
  resolveAzureFoundryModelSlug,
} from "../../fireworks/azure-core.mjs";
import {
  ANTHROPIC_BYOK_BODY_FIELD,
  ANTHROPIC_BYOK_HEADER,
  omitHeaders,
} from "../../firerouter/core.mjs";
import { assertIdeStopped, ensureIdeStopped, isIdeRunning, quitInstruction } from "../../io/ide-running.mjs";
import {
  withFireconnectRequestHeadersForModels,
} from "./request-headers.mjs";
import { detectVscodeInstall } from "./install.mjs";
import {
  decryptSecret,
  encryptSecret,
  isSecretEncryptionAvailable,
  linuxEncryptUsesBasicTextBackend,
  linuxSecretUsesKeyringBackend,
  secretEncryptionUnavailableMessage,
  storedSecretHasCiphertext,
} from "./safestorage.mjs";
import {
  applyItemTableWrites,
  ensureItemTable,
  readItemTableValue,
  writeItemTableValue,
} from "./vscdb-sqlite.mjs";

/**
 * VS Code Chat's custom language models live in `chatLanguageModels.json` (a
 * JSON array of providers). nexus adds a "Fireworks" provider whose
 * `apiKey` is a `${input:chat.lm.secret.<id>}` reference.
 *
 * The real key is NOT a per-secret OS keychain entry: VS Code's
 * `LanguageModelsService` resolves the reference via
 * `ISecretStorageService.get(<id>)`, which reads an Electron `safeStorage`-
 * encrypted blob from the application-scoped `state.vscdb` (`ItemTable`, key
 * `secret://<id>`). The harness therefore writes the key there — encrypted via
 * `vscode-safestorage.mjs` — so VS Code can actually decrypt and use it.
 *
 * - Provider entry -> array element `{ name, vendor:"customendpoint",
 *   apiType:"chat-completions", apiKey:"${input:<secretId>}", models[] }`
 *   (every route — direct Fireworks, `firerouter`, and Azure — uses the
 *   chat-completions wire).
 * - Model          -> `{ id, name, url, toolCalling, vision,
 *   maxInputTokens, maxOutputTokens }`. VS Code's `resolveCustomEndpointUrl`
 *   appends `/v1/chat/completions` (or `/v1/responses`) to `url` per apiType,
 *   so `https://api.fireworks.ai/inference` resolves correctly.
 * - Secret         -> `state.vscdb` `ItemTable` row, key `secret://<secretId>`,
 *   value = `JSON.stringify(safeStorage.encryptString(key))`.
 *
 * Ownership: fireconnect-generated secret ids use the prefix
 * `chat.lm.secret.fw-`. A provider is fireconnect-owned iff its `apiKey`
 * references a `fw-` secret. This keeps `off` from touching a user's
 * manually-configured "Fireworks" entry (which uses a VS Code-generated id).
 */

/** Storage-key prefix VS Code's secret storage uses inside `state.vscdb`. */
const SECRET_STORAGE_PREFIX = "secret://";

export const VSCODE_FIREWORKS_MODEL_URL = "https://api.fireworks.ai/inference";
/** Provider display name nexus writes. */
export const FIRECONNECT_PROVIDER_NAME = "Fireworks";
/** Secret id prefix that marks a provider as fireconnect-owned. */
export const FIRECONNECT_SECRET_PREFIX = "chat.lm.secret.fw-";

/* -------------------------------------------------------------------------- */
/* Path resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the path to VS Code's chatLanguageModels.json for the current platform.
 * @param {{ home?: string, vscodePath?: string }} opts
 * @returns {string}
 */
export function chatLanguageModelsPath({ home = "", vscodePath = "" } = {}) {
  if (vscodePath) {
    return path.resolve(vscodePath);
  }
  // Use the same install detection as the keychain service so the JSON path
  // and the keychain service always target the same variant (stable vs
  // Insiders). Falls back to the stable "Code" folder when no install is found.
  const folder = detectVscodeInstall()?.folder || "Code";
  const baseHome = home || process.env.HOME || "";
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(baseHome, "Library", "Application Support", folder, "User", "chatLanguageModels.json");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(baseHome, "AppData", "Roaming");
    return path.join(appData, folder, "User", "chatLanguageModels.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(baseHome, ".config");
  return path.join(configHome, folder, "User", "chatLanguageModels.json");
}

/**
 * Resolve the path to VS Code's application-scoped `state.vscdb` — the same
 * `User` dir as `chatLanguageModels.json` plus `globalStorage/state.vscdb`.
 * This is where VS Code's `ISecretStorageService` persists encrypted secrets.
 * @param {{ home?: string, vscodePath?: string }} opts
 * @returns {string}
 */
export function vscodeStateDbPath({ home = "", vscodePath = "" } = {}) {
  const jsonPath = chatLanguageModelsPath({ home, vscodePath });
  return path.join(path.dirname(jsonPath), "globalStorage", "state.vscdb");
}

/**
 * Resolve the path to VS Code's `Local State` file — the Chromium user-data
 * root that holds the OSCrypt `os_crypt.encrypted_key` (DPAPI-protected AES-256
 * key) on Windows. This is the parent of the `User/` directory that contains
 * `chatLanguageModels.json` and `globalStorage/state.vscdb`.
 * @param {{ home?: string, vscodePath?: string }} opts
 * @returns {string}
 */
export function vscodeLocalStatePath({ home = "", vscodePath = "" } = {}) {
  const jsonPath = chatLanguageModelsPath({ home, vscodePath });
  // jsonPath = <userData>/User/chatLanguageModels.json
  // Local State = <userData>/Local State  (parent of User/)
  return path.join(path.dirname(path.dirname(jsonPath)), "Local State");
}

/** @param {string} secretId @returns {string} the `secret://<id>` ItemTable key */
function secretStorageKey(secretId) {
  return `${SECRET_STORAGE_PREFIX}${secretId}`;
}

/* -------------------------------------------------------------------------- */
/* JSON I/O                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse raw chatLanguageModels.json text into the array shape callers expect:
 * non-arrays coerce to `[]`; a `SyntaxError` becomes a clear "not valid JSON"
 * message naming the file. Single source of truth for the parse/coercion rules.
 * @param {string} raw
 * @param {string} filePath  for error messages
 * @returns {object[]}
 */
function parseChatLanguageModelsRaw(raw, filePath) {
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} is not valid JSON`);
    }
    throw error;
  }
}

/**
 * Read the chatLanguageModels.json array. Returns `[]` when missing or empty.
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
export async function readChatLanguageModels(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, "utf8");
  return parseChatLanguageModelsRaw(raw, filePath);
}

/**
 * Write the array with VS Code's tab indentation (minimal diff).
 * @param {string} filePath
 * @param {object[]} arr
 * @returns {Promise<void>}
 */
export async function writeChatLanguageModels(filePath, arr) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(arr, null, "\t")}\n`);
}

/** Read the raw file text for byte-for-byte snapshot/restore. */
async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { existed: false, raw: "" };
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Ownership + secret id                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} apiKeyField the provider's `apiKey` value
 * @returns {string | null} the secret id if fireconnect-owned, else null
 */
export function fireconnectSecretId(apiKeyField) {
  if (typeof apiKeyField !== "string") {
    return null;
  }
  // apiKey is `${input:<secretId>}`; extract the secret id.
  const match = apiKeyField.match(/^\$\{input:(.+)\}$/);
  if (!match) {
    return null;
  }
  const secretId = match[1];
  return secretId.startsWith(FIRECONNECT_SECRET_PREFIX) ? secretId : null;
}

/** @returns {string} a fresh fireconnect-owned secret id */
export function makeFireconnectSecretId() {
  return `${FIRECONNECT_SECRET_PREFIX}${randomBytes(8).toString("hex")}`;
}

/**
 * @param {object} provider
 * @returns {boolean} whether the provider entry was created by nexus
 */
export function isFireconnectProvider(provider) {
  return fireconnectSecretId(provider?.apiKey) !== null;
}

/**
 * Find the fireconnect-owned provider entry, if any.
 * @param {object[]} arr
 * @returns {object | undefined}
 */
export function findFireconnectProvider(arr) {
  return (arr ?? []).find((p) => isFireconnectProvider(p));
}

/**
 * All fireconnect-owned secret ids referenced in the array (for `off` cleanup).
 * @param {object[]} arr
 * @returns {string[]}
 */
export function fireconnectSecretIds(arr) {
  return (arr ?? [])
    .map((p) => fireconnectSecretId(p?.apiKey))
    .filter(Boolean);
}

/**
 * @param {object[]} arr
 * @returns {"fireworks" | "none"}
 */
export function fireworksProviderStatus(arr) {
  return findFireconnectProvider(arr) ? "fireworks" : "none";
}

/**
 * Whether the nexus provider routes to Microsoft Foundry (Azure): a
 * chat-completions provider whose model URL points somewhere other than the
 * Fireworks gateway (and isn't FireRouter). "none" otherwise.
 * @param {object[]} arr
 * @returns {"azure" | "none"}
 */
export function vscodeAzureProviderStatus(arr) {
  const provider = findFireconnectProvider(arr);
  if (!provider || provider.apiType !== "chat-completions") {
    return "none";
  }
  const first = (provider.models ?? [])[0];
  if (first
    && typeof first.url === "string"
    && first.url !== VSCODE_FIREWORKS_MODEL_URL) {
    return "azure";
  }
  return "none";
}

/** @param {object[]} arr @returns {string[]} model ids nexus registered */
export function fireconnectRegisteredModels(arr) {
  const provider = findFireconnectProvider(arr);
  return (provider?.models ?? []).map((m) => m.id);
}

/**
 * BYOK credential stored on the FireRouter model (`requestHeaders` /
 * `anthropic_api_key`). Returns {} when absent.
 * @param {object[]} arr
 * @returns {Record<string, string>}
 */
export function vscodeStoredByokHeaders(arr) {
  const provider = findFireconnectProvider(arr);
  const model = (provider?.models ?? []).find((m) => firerouterRequiresAnthropicKey(m.id));
  if (!model) {
    return {};
  }
  const headers = { ...(model.requestHeaders ?? {}) };
  const fromBody = model[ANTHROPIC_BYOK_BODY_FIELD];
  if (fromBody && !headers[ANTHROPIC_BYOK_HEADER]) {
    headers[ANTHROPIC_BYOK_HEADER] = fromBody;
  }
  return headers;
}

/**
 * Drop saved provider keys from the Nexus provider's models in
 * `chatLanguageModels.json` (`requestHeaders`, plus the Anthropic body field),
 * after `nexus configure --unset anthropic-api-key` / `--unset openai-api-key`.
 * `dryRun` reports whether anything would be removed without writing.
 * @param {{ filePath: string, headerNames: string[], dryRun?: boolean }} opts
 * @returns {Promise<boolean>} whether the file changed (or would change)
 */
export async function removeVscodeSavedProviderKeys({ filePath, headerNames, dryRun = false }) {
  const arr = await readChatLanguageModels(filePath);
  const provider = findFireconnectProvider(arr);
  if (!provider?.models?.length) {
    return false;
  }
  const dropBodyKey = headerNames.some((name) => name.toLowerCase() === ANTHROPIC_BYOK_HEADER);
  let changed = false;
  const models = provider.models.map((model) => {
    const headers = omitHeaders(model.requestHeaders, headerNames);
    const dropBody = dropBodyKey && ANTHROPIC_BYOK_BODY_FIELD in model;
    if (!headers && !dropBody) {
      return model;
    }
    changed = true;
    const next = { ...model };
    if (dropBody) {
      delete next[ANTHROPIC_BYOK_BODY_FIELD];
    }
    if (headers && Object.keys(headers).length) {
      next.requestHeaders = headers;
    } else if (headers) {
      delete next.requestHeaders;
    }
    return next;
  });
  if (!changed || dryRun) {
    return changed;
  }
  await writeChatLanguageModels(filePath, arr.map((entry) => (entry === provider ? { ...provider, models } : entry)));
  return true;
}

/* -------------------------------------------------------------------------- */
/* Pure transforms (no I/O — unit-testable)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a model object for a Fireworks model id.
 * @param {string} modelId normalized Fireworks model id
 * @returns {object}
 */
export function buildModelEntry(modelId) {
  return {
    id: shortFireworksModelRef(modelId),
    name: isFirerouterModelPattern(modelId)
      ? firerouterDisplayName(modelId)
      : isAutoModelId(modelId)
        ? autoDisplayName(modelId)
        : prettyModelName(modelId),
    url: VSCODE_FIREWORKS_MODEL_URL,
    ...resolveModelDisplayMetadata(modelId),
  };
}

/**
 * Build a model object for a Microsoft Foundry (Azure) deployment. The
 * deployment name is used verbatim as the id/name, and the URL is the Foundry
 * resource base (VS Code appends `/chat/completions` to the `/openai/v1` base).
 * @param {string} modelId Foundry deployment name
 * @param {string} baseUrl normalized Foundry base URL
 * @returns {object}
 */
export function buildAzureModelEntry(modelId, baseUrl) {
  const slug = resolveAzureFoundryModelSlug(modelId);
  const metadataRef = slug ? `accounts/fireworks/models/${slug}` : modelId;
  return {
    id: modelId,
    name: modelId,
    url: baseUrl,
    ...resolveModelDisplayMetadata(metadataRef),
  };
}

/**
 * Add (or update) the fireconnect-owned Fireworks provider with the given
 * models. Replaces an existing nexus provider's models; leaves other
 * providers alone.
 *
 * `apiType` selects VS Code's request/response format for the group: both
 * direct Fireworks and Microsoft Foundry (Azure) use `chat-completions`.
 * VS Code resolves the endpoint path from the model `url` + apiType (bare
 * base → `<url>/v1/chat/completions` etc.), so the base URL is unchanged.
 * @param {object[]} arr
 * @param {{ secretId: string, models: object[], apiType?: "chat-completions" | "responses" }} opts
 * @returns {object[]} new array
 */
export function addFireworksProvider(arr, { secretId, models, apiType = "chat-completions" }) {
  const next = [...(arr ?? [])];
  const idx = next.findIndex(isFireconnectProvider);
  const provider = {
    name: FIRECONNECT_PROVIDER_NAME,
    vendor: "customendpoint",
    apiType,
    apiKey: `\${input:${secretId}}`,
    models: dedupeModels(models),
  };
  if (idx >= 0) {
    next[idx] = provider;
  } else {
    next.push(provider);
  }
  return next;
}

/**
 * Remove the fireconnect-owned provider entry. Other providers are untouched.
 * @param {object[]} arr
 * @returns {object[]} new array
 */
export function removeFireconnectProvider(arr) {
  return (arr ?? []).filter((p) => !isFireconnectProvider(p));
}

/* -------------------------------------------------------------------------- */
/* Model resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Default model id nexus registers for VS Code: the shared Fireworks
 * main model (`auto`).
 * @returns {string}
 */
export function defaultModelIdFor() {
  return fullFireworksResourceId(defaultMainModel());
}

/**
 * Resolve a user-supplied model id (`--model`), normalized, falling back to
 * the default.
 * @param {string | undefined} modelId
 * @returns {string}
 */
function resolveVscodeModelId(modelId) {
  return normalizeModelId(modelId || defaultModelIdFor());
}

/* -------------------------------------------------------------------------- */
/* Running-VS-Code guards.                                                     */
/*                                                                            */
/* `on`/`off` write the API key into `state.vscdb`, which a running VS Code     */
/* owns: it loads the DB into memory at startup and rewrites it on exit, so a   */
/* write made while it's open is silently lost (and won't be seen until the     */
/* next launch anyway). Those ops wait for a full quit when stdin is a TTY      */
/* (prompt + Enter, like Cursor); non-interactive runs throw; `--force` warns.   */
/* -------------------------------------------------------------------------- */

const VSCODE_PROCESS_SPEC = {
  // Match Stable and Insiders. `pgrep -f` matches the full command line; anchor
  // on the executable basename so paths like `/usr/share/code/` don't match
  // unrelated helpers (e.g. Chrome crashpad) whose cmdline merely contains "code".
  darwinPattern: "Visual Studio Code( - Insiders)?.app/Contents/MacOS/Electron",
  linuxPattern: "[/]code(-insiders)?([[:space:]]|$)",
  // Electron spawns `/usr/share/code/code --type=…` helpers that can outlive a
  // closed window or linger briefly after File > Quit. Only the main process
  // (no `--type=`) owns state.vscdb and must block writes.
  linuxCmdlineMatches: (cmdline) => !/\s--type=/.test(cmdline),
  windowsImage: "Code( - Insiders)?\\.exe",
};

const VSCODE_RUNNING_MESSAGE =
  `VS Code is running. ${quitInstruction("VS Code")} so the API key write to state.vscdb isn't discarded when VS Code exits, then rerun. Or pass --force to write anyway (not recommended).`;

/**
 * @returns {boolean} true if the VS Code GUI process is currently running.
 */
export function isVscodeRunning() {
  return isIdeRunning(VSCODE_PROCESS_SPEC);
}

/**
 * Wait for VS Code to be quit before writing. Interactive: when VS Code is
 * running and stdin is a TTY, waits for quit via Enter confirm and/or
 * auto-detect. `force` skips the wait (warns instead). Non-interactive throws
 * `VSCODE_RUNNING_MESSAGE`.
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureVscodeStopped({ force = false } = {}) {
  return ensureIdeStopped(VSCODE_PROCESS_SPEC, VSCODE_RUNNING_MESSAGE, { force, label: "VS Code" });
}

/**
 * Hard-error if VS Code is running (writes to `state.vscdb` would be lost).
 * `force` downgrades to a stderr warning. Prefer {@link ensureVscodeStopped} for
 * interactive `on`/`off`.
 * @param {{ force?: boolean }} [opts]
 */
export function assertVscodeStopped({ force = false } = {}) {
  assertIdeStopped(VSCODE_PROCESS_SPEC, VSCODE_RUNNING_MESSAGE, { force });
}

/* -------------------------------------------------------------------------- */
/* Snapshot/restore (mirror cursor-core's backup pattern)                      */
/* -------------------------------------------------------------------------- */

export const VSCODE_DATA_RELATIVE_DIR = ".nexus/vscode";

/**
 * VS Code's Nexus data dir (backup + state). Defaults to
 * `~/.nexus/vscode` unless overridden via `--data-dir`.
 * @param {string} home
 * @param {string} [dataDir]
 * @returns {string}
 */
export function vscodeDataDir(home, dataDir = "") {
  return dataDir || path.join(home, VSCODE_DATA_RELATIVE_DIR);
}

/**
 * @param {string} dataDir
 * @param {string} filePath
 */
export function vscodeBackupPath(dataDir, filePath) {
  const key = createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `vscode-backup.${key}.json`);
}

/** @param {string} dataDir @param {string} filePath @returns {Promise<object>} */
export async function readVscodeBackup(dataDir, filePath) {
  return readJsonIfExists(vscodeBackupPath(dataDir, filePath));
}

/**
 * One-time relocation of VS Code backups from the legacy shared Claude data dir
 * (`~/.nexus/claude`, where older releases wrote them because the
 * VS Code harness reused Claude's `resolveDataDir`) into VS Code's own data
 * dir. Idempotent; safe to call on every command. Leaves any claude-owned
 * `provider-*` files untouched.
 * @param {{ home: string, dataDir: string }} opts
 */
export async function relocateLegacyVscodeBackups({ home, dataDir }) {
  const newDir = vscodeDataDir(home, dataDir);
  const legacyDir = path.join(home, ".nexus/claude");
  if (path.resolve(newDir) === path.resolve(legacyDir) || !existsSync(legacyDir)) {
    return;
  }
  let entries;
  try {
    entries = await readdir(legacyDir);
  } catch {
    return; // legacy dir absent — nothing to relocate
  }
  await mkdir(newDir, { recursive: true, mode: 0o700 }).catch(() => {});
  for (const name of entries) {
    if (!name.startsWith("vscode-backup.")) continue;
    const from = path.join(legacyDir, name);
    const to = path.join(newDir, name);
    if (existsSync(to)) continue; // already migrated or a new `on` wrote here
    try {
      await rename(from, to);
    } catch {
      /* dest appeared between check and move; leave the legacy file in place */
    }
  }
}

/**
 * Persist a pre-Fireconnect snapshot (raw file text + the secret ids nexus
 * is about to create, for clean keychain cleanup on `off`). Owner-only perms.
 * @param {string} dataDir
 * @param {string} filePath
 * @param {{ fileExisted: boolean, fileRaw: string, secretIds: string[] }} snapshot
 * @returns {Promise<void>}
 */
export async function writeVscodeBackup(dataDir, filePath, snapshot) {
  const backupPath = vscodeBackupPath(dataDir, filePath);
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await writeJson(backupPath, { filePath: path.resolve(filePath), snapshot });
  await chmod(backupPath, 0o600);
}

/** @param {string} dataDir @param {string} filePath @returns {Promise<void>} */
export async function removeVscodeBackup(dataDir, filePath) {
  try {
    await unlink(vscodeBackupPath(dataDir, filePath));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Enable / disable / reset                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The VS Code variant whose `state.vscdb` we're writing to. The encryption
 * master key is per-variant (Stable reads "Code Safe Storage", Insiders reads
 * "Code - Insiders Safe Storage"), so this MUST match the DB we target.
 *
 * When `--vscode-path` points inside a known user-data dir, infer the variant
 * from the path ("Code - Insiders" vs "Code"). Otherwise fall back to install
 * detection (Stable preferred when both are installed).
 *
 * @param {string} [vscodePath] the resolved chatLanguageModels.json path, if known
 * @returns {"stable" | "insiders"}
 */
export function currentVariant(vscodePath) {
  if (vscodePath && /Code - Insiders/i.test(vscodePath)) {
    return "insiders";
  }
  return detectVscodeInstall()?.variant === "insiders" ? "insiders" : "stable";
}

/**
 * Enable Fireworks routing for VS Code Chat: snapshot the pre-Fireconnect file,
 * store the key (Electron `safeStorage`-encrypted) in `state.vscdb` under a
 * fresh `secret://chat.lm.secret.fw-<hex>` row, and add the Fireworks provider
 * entry with the resolved default model.
 *
 * @param {{ vscodePath: string, dataDir: string, apiKey: string, modelId?: string, stateDbPath?: string }} opts
 * @returns {Promise<{ model: string, secretId: string, stateDbPath: string }>}
 */
export async function enableVscodeFireworks({
  vscodePath,
  dataDir,
  apiKey,
  modelId,
  stateDbPath,
  byokHeaders = {},
  telemetryHeaders = {},
  catalogModelIds = [],
  catalogAvailable = false,
}) {
  if (!apiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const variant = currentVariant(vscodePath);
  const localStatePath = vscodeLocalStatePath({ vscodePath });
  if (!isSecretEncryptionAvailable({ variant, localStatePath })) {
    throw new Error(secretEncryptionUnavailableMessage(variant));
  }

  const resolvedModel = shortFireworksModelRef(resolveVscodeModelId(modelId));

  const { existed: fileExisted, raw: fileRaw } = await readRawIfExists(vscodePath);
  // Parse via the shared helper so the snapshot, the in-memory array, and
  // readChatLanguageModels all use identical coercion/error rules.
  const arr = parseChatLanguageModelsRaw(fileRaw, vscodePath);

  const backup = await readVscodeBackup(dataDir, vscodePath);
  const hasBackup = backup.snapshot !== undefined;
  const alreadyManaged = fireworksProviderStatus(arr) !== "none";
  // Only snapshot pre-Fireconnect state; never overwrite an existing backup
  // (so `off` can still restore the true original).
  if (!hasBackup && !alreadyManaged) {
    await writeVscodeBackup(dataDir, vscodePath, { fileExisted, fileRaw, secretIds: [] });
  }

  // If a nexus provider already exists, reuse its secret id; otherwise
  // generate one and store the key.
  const existing = findFireconnectProvider(arr);
  const secretId = existing ? fireconnectSecretId(existing.apiKey) : makeFireconnectSecretId();
  const dbPath = stateDbPath || vscodeStateDbPath({ vscodePath });
  // Ensure the ItemTable exists so `on` works against a profile VS Code has
  // never launched (no state.vscdb yet). Idempotent + mkdirs the parent.
  await ensureItemTable(dbPath);
  const encrypted = encryptSecret(apiKey, { variant, localStatePath });
  const obfuscatedKey = linuxEncryptUsesBasicTextBackend(encrypted);
  await writeItemTableValue(dbPath, secretStorageKey(secretId), encrypted);

  // Preserve previously registered models when re-running `on` (for example to
  // rotate a key). With `--model`, ensure that model is present; without it,
  // keep the existing list and only seed the default when the list is empty.
  let models = computeVscodeModels(
    existing,
    modelId,
    resolvedModel,
    catalogModelIds,
    catalogAvailable,
  );
  // FireRouter BYOK: attach x-anthropic-api-key as a per-model requestHeader on
  // the firerouter entry (VS Code sends it verbatim), even when it isn't the
  // active model. Telemetry applies to every Nexus-managed model.
  models = withFireconnectRequestHeadersForModels(models, {
    telemetryHeaders,
    byokHeaders,
  });

  const next = addFireworksProvider(arr, {
    secretId,
    models,
    // Direct Fireworks gateway uses the chat-completions API in VS Code Chat
    // (same as Azure; explicit for clarity even though it's the default).
    apiType: "chat-completions",
  });
  await writeChatLanguageModels(vscodePath, next);

  return {
    model: resolvedModel,
    modelsAdded: fireconnectRegisteredModels(next),
    secretId,
    stateDbPath: dbPath,
    obfuscatedKey,
    variant,
  };
}

/**
 * Route VS Code Chat through Fireworks models served on Microsoft Foundry
 * (Azure): store the Azure key (safeStorage-encrypted) in `state.vscdb` and add
 * a chat-completions provider with a single model pointed at the Foundry
 * resource. The Foundry deployment name is used verbatim. `off` reuses the
 * shared snapshot/strip path (`disableVscodeFireworks`).
 *
 * @param {{ vscodePath: string, dataDir: string, apiKey: string, baseUrl: string, modelId?: string, stateDbPath?: string }} opts
 * @returns {Promise<{ model: string, baseUrl: string, secretId: string, stateDbPath: string, apiKeyMode: "literal" }>}
 */
export async function enableVscodeAzure({
  vscodePath,
  dataDir,
  apiKey,
  baseUrl,
  modelId = "",
  stateDbPath,
}) {
  const normalizedBaseUrl = normalizeAzureBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error(MISSING_AZURE_BASE_URL_MESSAGE);
  }
  const effectiveApiKey = apiKey === AZURE_API_KEY_ENV_REF
    ? (process.env[AZURE_API_KEY_ENV] ?? "")
    : apiKey;
  if (!effectiveApiKey) {
    throw new Error(MISSING_AZURE_API_KEY_MESSAGE);
  }

  const variant = currentVariant(vscodePath);
  const localStatePath = vscodeLocalStatePath({ vscodePath });
  if (!isSecretEncryptionAvailable({ variant, localStatePath })) {
    throw new Error(secretEncryptionUnavailableMessage(variant));
  }

  const { existed: fileExisted, raw: fileRaw } = await readRawIfExists(vscodePath);
  const arr = parseChatLanguageModelsRaw(fileRaw, vscodePath);

  // Only reuse a deployment when Azure is already the active provider — never
  // carry over a Fireworks gateway catalog id (Foundry has no such deployment).
  const currentDeployment = vscodeAzureProviderStatus(arr) === "azure"
    ? (findFireconnectProvider(arr)?.models?.[0]?.id ?? "")
    : "";
  const resolvedModel = modelId || currentDeployment || DEFAULT_AZURE_MODEL;

  const backup = await readVscodeBackup(dataDir, vscodePath);
  const hasBackup = backup.snapshot !== undefined;
  const alreadyManaged = fireworksProviderStatus(arr) !== "none";
  if (!hasBackup && !alreadyManaged) {
    await writeVscodeBackup(dataDir, vscodePath, { fileExisted, fileRaw, secretIds: [] });
  }

  const existing = findFireconnectProvider(arr);
  const secretId = existing ? fireconnectSecretId(existing.apiKey) : makeFireconnectSecretId();
  const dbPath = stateDbPath || vscodeStateDbPath({ vscodePath });
  await ensureItemTable(dbPath);
  const encrypted = encryptSecret(effectiveApiKey, { variant, localStatePath });
  await writeItemTableValue(dbPath, secretStorageKey(secretId), encrypted);

  // addFireworksProvider replaces the provider's models, so switching from the
  // gateway drops the whole serverless catalog — only the deployment remains.
  const next = addFireworksProvider(arr, {
    secretId,
    models: [buildAzureModelEntry(resolvedModel, normalizedBaseUrl)],
  });
  await writeChatLanguageModels(vscodePath, next);

  return {
    model: resolvedModel,
    baseUrl: normalizedBaseUrl,
    secretId,
    stateDbPath: dbPath,
    apiKeyMode: "literal",
  };
}

/**
 * Compute the models list for the nexus provider on `on`.
 * @param {object | undefined} existing the current nexus provider, if any
 * @param {string | undefined} modelId the `--model` argument (raw)
 * @param {string} resolvedModel the normalized default/`--model` model id
 * @returns {object[]}
 */
function computeVscodeModels(existing, modelId, resolvedModel, catalogModelIds = [], catalogAvailable = false) {
  const existingModels = (existing?.models ?? []).map((model) => ({
    ...model,
    id: shortFireworksModelRef(model.id),
  }));
  const byId = new Map(existingModels.map((m) => [m.id, m]));
  const ensure = (id) => {
    const storedId = shortFireworksModelRef(id);
    if (storedId && !byId.has(storedId)) {
      byId.set(storedId, buildModelEntry(id));
    }
  };
  if (!existing) {
    // Shared fresh-install policy (see lib/harness/catalog-refresh.mjs).
    ensure(resolvedModel);
    for (const id of catalogModelIds) {
      ensure(id);
    }
  } else if (modelId) {
    ensure(resolvedModel);
  } else if (catalogAvailable) {
    // Shared catalog-refresh policy: prune delisted ids, add newly served
    // ones, and re-render kept rows from the fresh entries (display metadata
    // drifts as the serverless catalog evolves).
    const plan = planCatalogRefresh({
      currentIds: [...byId.keys()],
      freshIds: catalogModelIds.map((id) => shortFireworksModelRef(id)).filter(Boolean),
      keepUnserved: (id) => isAutoModelId(id) && !isAutoInstantModelId(id),
    });
    for (const id of plan.pruned) {
      byId.delete(id);
    }
    for (const id of [...plan.kept, ...plan.added]) {
      const fresh = buildModelEntry(id);
      // Metadata refresh must not drop request headers the user (or an
      // earlier run) set on the row — the write-time header merge updates
      // telemetry on top of these.
      const previous = byId.get(id);
      if (previous?.requestHeaders) {
        fresh.requestHeaders = previous.requestHeaders;
      }
      byId.set(id, fresh);
    }
  }
  const merged = [...byId.values()];
  if (existing && catalogAvailable && !modelId) {
    return merged;
  }
  return merged.length > 0 ? merged : [buildModelEntry(resolvedModel)];
}

/**
 * Disable Fireworks routing for VS Code Chat. If a pre-`on` snapshot exists,
 * restore the file byte-for-byte and delete the nexus secrets from
 * `state.vscdb`; otherwise strip only the fireconnect-owned provider + secrets.
 *
 * @param {{ vscodePath: string, dataDir: string, wasEnabled?: boolean, stateDbPath?: string }} opts
 * @returns {Promise<"restored" | "stripped" | "none">}
 */
export async function disableVscodeFireworks({
  vscodePath,
  dataDir,
  wasEnabled = false,
  stateDbPath,
}) {
  const dbPath = stateDbPath || vscodeStateDbPath({ vscodePath });
  const backup = await readVscodeBackup(dataDir, vscodePath);
  const hasBackup = backup.snapshot !== undefined;

  const arr = await readChatLanguageModels(vscodePath);
  const active = fireworksProviderStatus(arr) !== "none";

  if (hasBackup) {
    if (backup.filePath !== undefined && backup.filePath !== path.resolve(vscodePath)) {
      throw new Error(
        `VS Code backup was taken for ${backup.filePath}, not ${vscodePath}; refusing to restore.`,
      );
    }
    const { fileExisted, fileRaw, secretIds } = backup.snapshot;
    // Delete the secrets nexus created (snapshot-era + current) BEFORE
    // restoring the JSON. If this fails, abort with the file untouched so the
    // provider + secret stay consistent and the user can retry `off` (the
    // JSON restore and backup removal only run once the secrets are gone).
    const ids = new Set([...(secretIds ?? []), ...fireconnectSecretIds(arr)]);
    await deleteSecrets(dbPath, [...ids]);
    if (fileExisted) {
      await mkdir(path.dirname(vscodePath), { recursive: true });
      await writeFileAtomic(vscodePath, fileRaw);
    } else {
      try {
        await unlink(vscodePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    await removeVscodeBackup(dataDir, vscodePath);
    return "restored";
  }

  if (!wasEnabled && !active) {
    return "none";
  }

  // No backup: strip only what nexus owns. If the user configured a
  // Fireworks provider manually (no fw- secret), leave it alone.
  const ids = fireconnectSecretIds(arr);
  if (ids.length === 0) {
    return "none";
  }
  // Same ordering: remove the secrets first, then rewrite the JSON. A failure
  // here leaves an orphaned encrypted row (harmless) rather than a provider
  // entry pointing at a deleted secret.
  await deleteSecrets(dbPath, ids);
  const next = removeFireconnectProvider(arr);
  if (next.length === 0) {
    try {
      await unlink(vscodePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  } else {
    await writeChatLanguageModels(vscodePath, next);
  }
  return "stripped";
}

/**
 * Delete the given nexus secret ids from `state.vscdb` in one transaction.
 * @param {string} dbPath
 * @param {string[]} secretIds
 * @returns {Promise<void>}
 */
async function deleteSecrets(dbPath, secretIds) {
  if (!secretIds.length || !existsSync(dbPath)) {
    return;
  }
  await applyItemTableWrites(
    dbPath,
    secretIds.map((id) => ({ op: "del", key: secretStorageKey(id) })),
  );
}

/**
 * Read the harness-local Fireworks key — decrypt the `secret://<id>` row from
 * `state.vscdb` referenced by the nexus provider in the JSON. Returns ""
 * when none is present or it can't be decrypted.
 *
 * Pass `arr` (the already-parsed chatLanguageModels.json array) when the caller
 * has it in hand to avoid re-reading the file; it's read from disk otherwise.
 * @param {string} vscodePath
 * @param {string} [stateDbPath]
 * @param {object[]} [arr] pre-parsed chatLanguageModels.json array
 * @returns {Promise<string>}
 */
export async function readVscodeStoredKey(vscodePath, stateDbPath, arr) {
  const providerArr = arr ?? await readChatLanguageModels(vscodePath);
  const secretId = fireconnectSecretIds(providerArr)[0];
  if (!secretId) {
    return "";
  }
  const dbPath = stateDbPath || vscodeStateDbPath({ vscodePath });
  const stored = await readItemTableValue(dbPath, secretStorageKey(secretId));
  if (!stored) {
    return "";
  }
  const key = decryptSecret(stored, { variant: currentVariant(vscodePath), localStatePath: vscodeLocalStatePath({ vscodePath }) });
  return isFireworksShapedKey(key) ? key.trim() : "";
}

/**
 * Re-encrypt the Fireworks gateway key into the nexus provider's
 * `state.vscdb` secret after a key rotation. Azure providers hold a Foundry
 * key and are left alone. Throws while VS Code is running: it rewrites
 * `state.vscdb` on exit and would silently drop the new key.
 *
 * Also throws, leaving the row untouched, when the existing secret can't be
 * decrypted or when the rewrite would downgrade a Linux keyring (v11) secret
 * to the obfuscated "peanuts" (v10) backend: our decrypt path has fallbacks
 * the encrypt path doesn't, so overwriting there could replace a secret
 * VS Code reads fine with one encrypted under a different scheme.
 * @param {{ vscodePath: string, stateDbPath?: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>} whether the stored key changed
 */
export async function refreshVscodeGatewayKey({ vscodePath, stateDbPath, fireworksKey }) {
  const arr = await readChatLanguageModels(vscodePath);
  const secretId = fireconnectSecretIds(arr)[0];
  if (!secretId || vscodeAzureProviderStatus(arr) === "azure") {
    return false;
  }
  const dbPath = stateDbPath || vscodeStateDbPath({ vscodePath });
  const cryptoOpts = { variant: currentVariant(vscodePath), localStatePath: vscodeLocalStatePath({ vscodePath }) };
  const stored = await readItemTableValue(dbPath, secretStorageKey(secretId));
  const current = stored ? decryptSecret(stored, cryptoOpts).trim() : "";
  if (current === fireworksKey) {
    return false;
  }
  if (!current && storedSecretHasCiphertext(stored)) {
    throw new Error("Could not decrypt VS Code's stored API key; left it unchanged.");
  }
  assertVscodeStopped();
  const encrypted = encryptSecret(fireworksKey, cryptoOpts);
  if (linuxSecretUsesKeyringBackend(stored) && linuxEncryptUsesBasicTextBackend(encrypted)) {
    throw new Error("VS Code's API key is keyring-encrypted but Nexus can only write an obfuscated one here; left it unchanged.");
  }
  await writeItemTableValue(dbPath, secretStorageKey(secretId), encrypted);
  return true;
}

/**
 * Read and decrypt the `secret://<secretId>` row from `state.vscdb`, returning it
 * verbatim (no Fireworks-shape filter). Returns "" when the row is absent or
 * cannot be decrypted. Unlike `readVscodeStoredKey`, this does not filter by key
 * shape, so Azure credentials can be read as well.
 * @param {{ vscodePath: string, stateDbPath?: string, secretId: string }} opts
 * @returns {Promise<string>}
 */
export async function readVscodeSecret({ vscodePath, stateDbPath, secretId }) {
  if (!secretId) return "";
  const dbPath = stateDbPath || vscodeStateDbPath({ vscodePath });
  const stored = await readItemTableValue(dbPath, secretStorageKey(secretId));
  if (!stored) return "";
  const key = decryptSecret(stored, { variant: currentVariant(vscodePath), localStatePath: vscodeLocalStatePath({ vscodePath }) });
  return typeof key === "string" ? key.trim() : "";
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Dedupe model objects by id, preserving order. */
function dedupeModels(models) {
  const seen = new Set();
  const out = [];
  for (const m of models ?? []) {
    if (m && m.id && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

// prettyModelName is shared across harnesses — see fireworks-models.mjs for the
// canonical implementation. Re-exported here so existing vscode imports resolve
// to the single source of truth.
export { prettyModelName };
