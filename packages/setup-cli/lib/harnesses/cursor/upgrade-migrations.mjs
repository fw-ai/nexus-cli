import { existsSync } from "node:fs";

import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { MigrationSkippedError } from "../../system/migration-skip.mjs";
import { cursorPathsFor } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import {
  APPLICATION_USER_KEY,
  cursorProviderStatus,
  dropCursorFirerouterSelection,
  readCursorState,
} from "./core.mjs";
import { applyCursorWrites, isCursorRunning } from "./sqlite.mjs";

/**
 * Move a Nexus-routed Cursor install off FireRouter on upgrade: a mode
 * whose selected model is a FireRouter route becomes `nexus/auto` (the row
 * itself is registered by the upgrade's auto backfill, which runs later in
 * the same finalize), and FireRouter rows leave the picker lists. No-ops
 * when Cursor isn't Nexus-routed, when nothing names a FireRouter route,
 * or while Cursor is running (its exit rewrite would discard the edit).
 * The `off` snapshot lives outside the blob, so it is never touched.
 * @param {string} home
 * @param {{ isRunning?: () => boolean }} [options]
 * @returns {Promise<boolean>} true when the blob was rewritten
 */
export async function migrateCursorFirerouterOnUpgrade(home, { isRunning = isCursorRunning } = {}) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CURSOR)) {
    return false;
  }
  const dbPath = cursorPathsFor({ home }).dbPath;
  if (!existsSync(dbPath)) {
    return false;
  }
  const { blob, openAIKey } = await readCursorState(dbPath);
  if (cursorProviderStatus(blob, openAIKey) !== "fireworks") {
    return false;
  }
  const { blob: next, changed } = dropCursorFirerouterSelection(blob);
  if (!changed) {
    return false;
  }
  if (isRunning()) {
    throw new MigrationSkippedError("Cursor is running");
  }
  await applyCursorWrites(dbPath, [
    { op: "set", key: APPLICATION_USER_KEY, value: JSON.stringify(next) },
  ]);
  return true;
}
