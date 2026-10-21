import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  isEnabledFireworksHarness,
  readGlobalConfig,
} from "../config/global-config.mjs";
import {
  copilotAppPathsFor,
  copilotCliPathsFor,
  cursorPathsFor,
} from "./context.mjs";
import { HARNESS, HARNESSES } from "./id.mjs";
import { readJsonIfExists, writeJson } from "../io/json.mjs";
import { writeFileAtomic } from "../io/atomic-write.mjs";
import { shortFireworksModelRef } from "../fireworks/model-id.mjs";
import { buildFireconnectTelemetryHeaders } from "../telemetry/request-headers.mjs";
import {
  copilotModelIds,
  describeCopilotAppModels,
  describeCopilotModels,
} from "../harnesses/copilot-shared.mjs";
import {
  findFireconnectProvider as findCopilotProvider,
  insertCopilotProviderModel,
  isCopilotRunning,
  listCopilotProviderModels,
} from "../harnesses/copilot-app/sqlite.mjs";
import { buildCliModels, readCopilotCliState } from "../harnesses/copilot-cli/config.mjs";
import {
  APPLICATION_USER_KEY,
  CURSOR_AUTO_MODEL_ID,
  addUserModel,
  cursorProviderStatus,
  fireconnectRegisteredModels,
  readCursorState,
} from "../harnesses/cursor/core.mjs";
import { applyCursorWrites, isCursorRunning } from "../harnesses/cursor/sqlite.mjs";
import {
  codexCatalogPath,
  codexConfigPath,
  fireconnectManagedVariant,
} from "../harnesses/codex/core.mjs";
import { parseToml } from "../harnesses/codex/toml.mjs";
import {
  buildCodexAutoCatalogEntry,
  codexCatalogContainsModel,
} from "../harnesses/codex/catalog.mjs";
import { isChatGptRunning } from "../harnesses/codex/ide-running.mjs";
import {
  OPENCODE_FIREWORKS_PROVIDER_ID,
  buildOpencodeModelEntry,
  opencodeConfigPath,
  opencodeProviderModelKey,
  opencodeProviderStatus,
  readRawIfExists,
  writeOpencodeConfig,
} from "../harnesses/opencode/core.mjs";
import {
  buildModelEntry,
  chatLanguageModelsPath,
  findFireconnectProvider as findVscodeProvider,
  isVscodeRunning,
  readChatLanguageModels,
  writeChatLanguageModels,
} from "../harnesses/vscode/core.mjs";
import { withFireconnectRequestHeaders } from "../harnesses/vscode/request-headers.mjs";

/**
 * Ensure the `auto` mix is registered in one harness's picker catalog.
 *
 * Single entry point for the auto backfill: `nexus update` (via the
 * forward migrations) and any other caller switch on the harness id here.
 * Every branch is key-independent (static spec, no network), skips running
 * IDEs, and never touches the active model selection.
 * Claude is separately handled and DeepSeek has no catalog, so both no-op.
 * Unknown ids throw, like the harness registry.
 *
 * @param {string} harnessId one of {@link HARNESSES}
 * @param {string} home
 * @param {object} [opts] `{ isRunning }` override for the running-IDE guard;
 *   primarily a test seam — production callers pass nothing.
 * @returns {Promise<boolean>} true when that harness's catalog was updated
 */
export async function ensureAutoCatalogEntry(harnessId, home, opts = {}) {
  switch (harnessId) {
    case HARNESS.CLAUDE:
    case HARNESS.DEEPSEEK:
    case HARNESS.PI:
      // Claude and Pi are separately handled (Pi by refreshPiCatalog);
      // DeepSeek has no catalog.
      return false;
    case HARNESS.OPENCODE:
    case HARNESS.CODEX:
    case HARNESS.CURSOR:
    case HARNESS.VSCODE:
    case HARNESS.COPILOT_APP:
    case HARNESS.COPILOT_CLI:
      break;
    default:
      throw new Error(`Unknown harness: ${harnessId}. Choose one of: ${HARNESSES.join(", ")}`);
  }
  // Upgrade only touches harnesses that are actually on. Each branch below
  // additionally verifies its own managed config before writing anything.
  if (!(await enabledFireworksHarness(home, harnessId))) {
    return false;
  }
  switch (harnessId) {
    case HARNESS.OPENCODE:
      return ensureOpencodeAuto(home);
    case HARNESS.CODEX:
      return ensureCodexAuto(home, opts);
    case HARNESS.CURSOR:
      return ensureCursorAuto(home, opts);
    case HARNESS.VSCODE:
      return ensureVscodeAuto(home, opts);
    case HARNESS.COPILOT_APP:
      return ensureCopilotAppAuto(home, opts);
    default:
      return ensureCopilotCliAuto(home);
  }
}

/**
 * Single gate for the upgrade backfill: the harness must be flagged on
 * (and not on Azure). Returns the harness map for branches that need more
 * than the flag (Pi's managed-id record), null otherwise.
 */
async function enabledFireworksHarness(home, harnessId) {
  if (!home) {
    return null;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, harnessId)) {
    return null;
  }
  return harnesses;
}

async function ensureOpencodeAuto(home) {
  const resolvedPath = opencodeConfigPath(home);
  const snapshot = await readRawIfExists(resolvedPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return false;
  }
  const config = JSON.parse(snapshot.raw);
  if (opencodeProviderStatus(config) !== "fireworks") {
    return false;
  }
  // Creating provider["fireworks-ai"] would claim a native v2 entry the user owns.
  if (!config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID] && config.providers?.[OPENCODE_FIREWORKS_PROVIDER_ID]) {
    return false;
  }
  const provider = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID] ?? {};
  const models = { ...(provider.models ?? {}) };
  if (Object.keys(models).some((id) => opencodeProviderModelKey(id) === "auto")) {
    return false;
  }
  const storedApiKey = provider.options?.apiKey;
  await writeOpencodeConfig(resolvedPath, {
    ...config,
    provider: {
      ...config.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: {
        ...provider,
        models: { auto: buildOpencodeModelEntry("auto"), ...models },
      },
    },
  }, { mode: typeof storedApiKey === "string" && storedApiKey ? 0o600 : undefined });
  return true;
}

async function ensureCodexAuto(home, { isRunning = isChatGptRunning } = {}) {
  if (isRunning()) {
    return false;
  }
  const resolvedConfigPath = codexConfigPath(home);
  const snapshot = await readRawIfExists(resolvedConfigPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return false;
  }
  const doc = parseToml(snapshot.raw);
  if (fireconnectManagedVariant(doc) !== "fireworks") {
    return false;
  }
  const ref = typeof doc.root.model_catalog_json === "string" ? doc.root.model_catalog_json.trim() : "";
  if (!ref) {
    // No catalog reference: leave the install alone. A fresh offline `on`
    // writes no catalog either, so inventing an auto-only file here would
    // swap Codex's default metadata for a one-model picker until the next
    // networked `on` rebuilds the full catalog.
    return false;
  }
  const resolvedCatalogPath = resolveCodexCatalogPath(home, ref);
  const catalog = await readJsonIfExists(resolvedCatalogPath);
  if (!Array.isArray(catalog.models)) {
    return false;
  }
  if (codexCatalogContainsModel(catalog, "auto")) {
    return false;
  }
  const nextRows = [buildCodexAutoCatalogEntry("auto"), ...catalog.models];
  await mkdir(path.dirname(resolvedCatalogPath), { recursive: true, mode: 0o700 });
  await writeJson(resolvedCatalogPath, { ...catalog, models: nextRows }, { mode: 0o600 });
  return true;
}

/** Catalog file for a managed Codex config: its `model_catalog_json` ref, else the default path. */
function resolveCodexCatalogPath(home, ref) {
  if (ref.startsWith("~/")) {
    return path.join(home, ref.slice("~/".length));
  }
  if (path.isAbsolute(ref)) {
    return ref;
  }
  return codexCatalogPath(home);
}

async function ensureCursorAuto(home, { isRunning = isCursorRunning } = {}) {
  const resolvedDbPath = cursorPathsFor({ home }).dbPath;
  if (!existsSync(resolvedDbPath)) {
    return false;
  }
  if (isRunning()) {
    return false;
  }
  const { blob, openAIKey } = await readCursorState(resolvedDbPath);
  if (cursorProviderStatus(blob, openAIKey) !== "fireworks") {
    return false;
  }
  const toShortRef = (id) => shortFireworksModelRef(String(id ?? ""));
  if (fireconnectRegisteredModels(blob).map(toShortRef).includes(CURSOR_AUTO_MODEL_ID)
    || (blob?.aiSettings?.userAddedModels ?? []).map(toShortRef).includes(CURSOR_AUTO_MODEL_ID)) {
    return false;
  }
  const next = addUserModel(blob, "auto");
  await applyCursorWrites(resolvedDbPath, [
    { op: "set", key: APPLICATION_USER_KEY, value: JSON.stringify(next) },
  ]);
  return true;
}

async function ensureVscodeAuto(home, { isRunning = isVscodeRunning } = {}) {
  const jsonPath = chatLanguageModelsPath({ home });
  const arr = await readChatLanguageModels(jsonPath);
  const provider = findVscodeProvider(arr);
  if (!provider) {
    return false;
  }
  const ids = (provider.models ?? []).map((model) => shortFireworksModelRef(model?.id));
  if (ids.includes("auto")) {
    return false;
  }
  if (isRunning()) {
    return false;
  }
  // Only the new row gets headers. Existing models keep theirs as written by
  // `on`, so an upgrade can't drop a BYOK key.
  const autoEntry = withFireconnectRequestHeaders(buildModelEntry("auto"), {
    telemetryHeaders: buildFireconnectTelemetryHeaders(HARNESS.VSCODE),
  });
  const models = [autoEntry, ...(provider.models ?? [])];
  await writeChatLanguageModels(
    jsonPath,
    arr.map((p) => (p === provider ? { ...p, models } : p)),
  );
  return true;
}

async function ensureCopilotAppAuto(home, { isRunning = isCopilotRunning } = {}) {
  const resolvedDbPath = copilotAppPathsFor({ home }).dbPath;
  if (!existsSync(resolvedDbPath)) {
    return false;
  }
  if (isRunning()) {
    return false;
  }
  const provider = await findCopilotProvider(resolvedDbPath);
  if (!provider) {
    return false;
  }
  const ids = copilotModelIds(
    (await listCopilotProviderModels(resolvedDbPath, provider.id)).map((model) => model.model_id),
  );
  if (ids.includes("auto")) {
    return false;
  }
  const [auto] = describeCopilotAppModels(["auto"]);
  await insertCopilotProviderModel(resolvedDbPath, { providerId: provider.id, model: auto });
  return true;
}

async function ensureCopilotCliAuto(home) {
  const resolvedPath = copilotCliPathsFor({ home }).providersPath;
  const config = await readJsonIfExists(resolvedPath);
  const state = await readCopilotCliState(resolvedPath);
  if (!state.configured) {
    return false;
  }
  if (copilotModelIds(state.models).includes("auto")) {
    return false;
  }
  if (!Array.isArray(config.models)) {
    return false;
  }
  const [auto] = buildCliModels(describeCopilotModels(["auto"]));
  await writeFileAtomic(resolvedPath, `${JSON.stringify({ ...config, models: [...config.models, auto] }, null, 2)}\n`);
  await chmod(resolvedPath, 0o600).catch(() => {});
  return true;
}
