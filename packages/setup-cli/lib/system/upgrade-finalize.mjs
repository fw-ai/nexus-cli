import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { finalizeInstallOrUpgrade } from "./finalize-install.mjs";

/**
 * Post-reset upgrade finalize. When the durable CLI is on disk, spawn it in a
 * fresh process so migrations load from the updated checkout rather than the
 * old process's ESM module cache. Fall back to in-process finalize when the
 * installed CLI is missing (dev trees, tests).
 *
 * The child's output (stdio: inherit) already names the problem when it
 * fails, so a failure here is rethrown as what it means — the update did
 * not finish — instead of the child's raw `Command failed: node …` exec
 * error, which says nothing about what to do next.
 *
 * @param {string} home
 * @param {string} installDir
 * @param {{
 *   execFile?: typeof execFileSync,
 *   exists?: typeof existsSync,
 *   finalizeInProcess?: typeof finalizeInstallOrUpgrade,
 * }} [dependencies]
 */
export async function runUpgradeFinalize(home, installDir, {
  execFile = execFileSync,
  exists = existsSync,
  finalizeInProcess = finalizeInstallOrUpgrade,
} = {}) {
  const updatedCli = path.join(installDir, "packages/setup-cli/bin/nexus.mjs");
  if (!exists(updatedCli)) {
    const result = await finalizeInProcess({ home, installDir });
    if (result?.renameBlocked) {
      throw new Error("Update did not finish: rename or remove ~/.nexus, then run the update again.");
    }
    return;
  }

  try {
    execFile(process.execPath, [updatedCli, "finalize-install"], {
      env: { ...process.env, HOME: home },
      stdio: "inherit",
    });
  } catch {
    throw new Error("Update did not finish: the finalize step failed (see above). Fix that, then run the update again.");
  }
}
