import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { deepseekPathsFor } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { migrateDeepseekFirerouterModel } from "./core.mjs";

/**
 * Move a connected DeepSeek Harness install off FireRouter on upgrade,
 * across the settings layer and every `cordis.patch.yml` layer an earlier
 * `on` wrote. Key-independent and snapshot-safe (see
 * `migrateDeepseekFirerouterModel`).
 * @param {string} home
 * @returns {Promise<boolean>} true when any layer was rewritten
 */
export async function migrateDeepseekFirerouterOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.DEEPSEEK)) {
    return false;
  }
  const { settingsPath } = deepseekPathsFor({ home });
  return migrateDeepseekFirerouterModel({ settingsPath });
}
