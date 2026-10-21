import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { isRetiredModelId, shortFireworksModelRef } from "../../fireworks/model-id.mjs";
import { HARNESS } from "../../harness/id.mjs";
import {
  chatLanguageModelsPath,
  findFireconnectProvider,
  isVscodeRunning,
  readChatLanguageModels,
  writeChatLanguageModels,
} from "./core.mjs";

/**
 * Flip the fireconnect-owned provider's `apiType` from `"responses"` to
 * `"chat-completions"` — the upgrade migration for installs configured when
 * direct Fireworks routing used the Responses wire. No-ops (returns `false`)
 * when there is no nexus provider, when it is already chat-completions
 * (Azure included), or when VS Code is running (its exit rewrite would
 * discard the edit). The secret store is untouched — the `apiKey` reference
 * and the `state.vscdb` row stay as they are.
 *
 * `isRunning` is injectable so the guard is unit-testable without a real IDE.
 * @param {string} home
 * @param {{ vscodePath?: string, isRunning?: () => boolean }} [options]
 * @returns {Promise<boolean>} whether the file was rewritten
 */
export async function migrateVscodeResponsesApiType(home, {
  vscodePath = "",
  isRunning = isVscodeRunning,
} = {}) {
  const jsonPath = vscodePath || chatLanguageModelsPath({ home });
  const arr = await readChatLanguageModels(jsonPath);
  const provider = findFireconnectProvider(arr);
  if (!provider || provider.apiType !== "responses") {
    return false;
  }
  if (isRunning()) {
    return false;
  }
  await writeChatLanguageModels(
    jsonPath,
    arr.map((p) => (p === provider ? { ...p, apiType: "chat-completions" } : p)),
  );
  return true;
}

/**
 * Remove FireRouter rows from the fireconnect provider's model list on
 * upgrade — VS Code has no Nexus-owned active selection, so the picker rows
 * are the whole FireRouter footprint. No-ops without a Nexus provider, when
 * no row names a FireRouter route, or while VS Code is running.
 * @param {string} home
 * @param {{ vscodePath?: string, isRunning?: () => boolean }} [options]
 * @returns {Promise<boolean>} whether the file was rewritten
 */
export async function migrateVscodeFirerouterOnUpgrade(home, {
  vscodePath = "",
  isRunning = isVscodeRunning,
} = {}) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.VSCODE)) {
    return false;
  }
  const jsonPath = vscodePath || chatLanguageModelsPath({ home });
  const arr = await readChatLanguageModels(jsonPath);
  const provider = findFireconnectProvider(arr);
  if (!provider) {
    return false;
  }
  const models = (provider.models ?? []).filter(
    (model) => !isRetiredModelId(shortFireworksModelRef(model?.id ?? "")),
  );
  if (models.length === (provider.models ?? []).length) {
    return false;
  }
  if (isRunning()) {
    return false;
  }
  await writeChatLanguageModels(
    jsonPath,
    arr.map((p) => (p === provider ? { ...p, models } : p)),
  );
  return true;
}
