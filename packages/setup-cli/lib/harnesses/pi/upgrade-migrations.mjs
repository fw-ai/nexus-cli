import { isHarnessEnabled } from "../../config/global-config.mjs";
import { piPathsFor } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { refreshPiCatalog } from "./core.mjs";

/**
 * Recompute an enabled Pi's Nexus model rows (see refreshPiCatalog).
 * @param {string} home
 * @returns {Promise<boolean>} true when Pi's config was updated
 */
export async function refreshPiCatalogForHome(home) {
  if (!home || !await isHarnessEnabled(home, HARNESS.PI)) {
    return false;
  }
  return refreshPiCatalog({ ...piPathsFor({ home }), home });
}
