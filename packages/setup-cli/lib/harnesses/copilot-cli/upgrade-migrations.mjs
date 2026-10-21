import { chmod } from "node:fs/promises";

import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { dropRetiredModelId, isRetiredModelId } from "../../fireworks/model-id.mjs";
import { copilotCliPathsFor } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { readJsonIfExists } from "../../io/json.mjs";
import {
  copilotCliModelIdFromSelection,
  copilotCliSelectionId,
  readCopilotCliState,
  selectCopilotCliModel,
} from "./config.mjs";

/**
 * Move a connected Copilot CLI install off FireRouter on upgrade: a
 * FireRouter selection becomes the `auto` mix (registered by the upgrade's
 * auto backfill, which runs after this), and FireRouter rows leave
 * providers.json. Installs that aren't Nexus-configured are left alone.
 * @param {string} home
 * @returns {Promise<boolean>} true when any file was updated
 */
export async function migrateCopilotCliFirerouterOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.COPILOT_CLI)) {
    return false;
  }
  const paths = copilotCliPathsFor({ home });
  const state = await readCopilotCliState(paths.providersPath, paths.settingsPath);
  if (!state.configured) {
    return false;
  }
  const selection = copilotCliModelIdFromSelection(state.selectedModel);
  const migrated = dropRetiredModelId(selection);
  let changed = false;
  if (selection && migrated !== selection) {
    await selectCopilotCliModel({
      settingsPath: paths.settingsPath,
      dataDir: paths.dataDir,
      selectionId: copilotCliSelectionId(migrated),
    });
    changed = true;
  }
  const config = await readJsonIfExists(paths.providersPath);
  if (Array.isArray(config.models)) {
    const models = config.models.filter(
      (model) => !isRetiredModelId(typeof model?.id === "string" ? model.id : ""),
    );
    if (models.length !== config.models.length) {
      await writeFileAtomic(paths.providersPath, `${JSON.stringify({ ...config, models }, null, 2)}\n`);
      await chmod(paths.providersPath, 0o600).catch(() => {});
      changed = true;
    }
  }
  return changed;
}
