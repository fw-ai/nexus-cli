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
    await finalizeInProcess({ home, installDir });
    return;
  }

  execFile(process.execPath, [updatedCli, "finalize-install"], {
    env: { ...process.env, HOME: home },
    stdio: "inherit",
  });
}
