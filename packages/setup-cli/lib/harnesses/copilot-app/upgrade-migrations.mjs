import { existsSync } from "node:fs";

import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { isRetiredModelId } from "../../fireworks/model-id.mjs";
import { copilotAppPathsFor } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { MigrationSkippedError } from "../../system/migration-skip.mjs";
import { copilotModelIds } from "../copilot-shared.mjs";
import {
  deleteCopilotProviderModels,
  findFireconnectProvider,
  isCopilotRunning,
  listCopilotProviderModels,
} from "./sqlite.mjs";

/**
 * Remove FireRouter rows from the Copilot app's Nexus provider on upgrade —
 * the app has no Nexus-owned active selection, so the registered rows are
 * the whole FireRouter footprint. No-ops without a Nexus provider, when no
 * row names a FireRouter route, or while the app is running (its exit
 * rewrite would discard the edit).
 * @param {string} home
 * @param {{ isRunning?: () => boolean }} [options]
 * @returns {Promise<boolean>} true when rows were deleted
 */
export async function migrateCopilotAppFirerouterOnUpgrade(home, { isRunning = isCopilotRunning } = {}) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.COPILOT_APP)) {
    return false;
  }
  const dbPath = copilotAppPathsFor({ home }).dbPath;
  if (!existsSync(dbPath)) {
    return false;
  }
  const provider = await findFireconnectProvider(dbPath);
  if (!provider) {
    return false;
  }
  const ids = copilotModelIds(
    (await listCopilotProviderModels(dbPath, provider.id)).map((model) => model.model_id),
  ).filter((id) => isRetiredModelId(id));
  if (!ids.length) {
    return false;
  }
  if (isRunning()) {
    throw new MigrationSkippedError("the Copilot app is running");
  }
  await deleteCopilotProviderModels(dbPath, provider.id, ids);
  return true;
}
