import "./legacy-env.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DATA_DIRNAME, LEGACY_DATA_DIRNAME } from "./data-dir.mjs";
import { runUpgradeFinalize } from "./upgrade-finalize.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * Recognize only the durable curl-installer layout. Package lifecycle scripts
 * also run in development checkouts and global npm installs; those must never
 * mutate a user's harness settings.
 *
 * @param {string} setupDir absolute packages/setup-cli path
 * @returns {{ home: string, installDir: string } | null}
 */
export function durableInstallContext(setupDir) {
  const resolvedSetup = path.resolve(setupDir);
  if (
    path.basename(resolvedSetup) !== "setup-cli"
    || path.basename(path.dirname(resolvedSetup)) !== "packages"
  ) {
    return null;
  }
  const installDir = path.dirname(path.dirname(resolvedSetup));
  const fireconnectDir = path.dirname(installDir);
  if (
    path.basename(installDir) !== "cli"
    || ![DATA_DIRNAME, LEGACY_DATA_DIRNAME].includes(path.basename(fireconnectDir))
  ) {
    return null;
  }
  return {
    home: path.dirname(fireconnectDir),
    installDir,
  };
}

/**
 * Bootstrap the fresh-process finalizer for clients whose old upgrader cannot
 * re-exec after replacing its own checkout. Failure propagates through npm so
 * the old upgrader reports that postflight did not complete.
 *
 * @param {{
 *   setupDir?: string,
 *   finalize?: typeof runUpgradeFinalize,
 * }} [dependencies]
 */
export async function runPostinstallFinalize({
  setupDir = path.resolve(path.dirname(THIS_FILE), "..", ".."),
  finalize = runUpgradeFinalize,
} = {}) {
  // Released upgraders still pass the pre-rename name while they install deps.
  if (process.env.NEXUS_SKIP_POSTINSTALL_FINALIZE === "1" || process.env.FIRECONNECT_SKIP_POSTINSTALL_FINALIZE === "1") {
    return false;
  }
  const context = durableInstallContext(setupDir);
  if (!context) {
    return false;
  }
  await finalize(context.home, context.installDir);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
  await runPostinstallFinalize();
}
