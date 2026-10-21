import { readGlobalConfig } from "../config/global-config.mjs";
import { reconcileShellEnvHook } from "../io/shell-env-hook.mjs";
import { needsFireworksShellExport } from "../io/shell-fireworks-consumers.mjs";
import { shouldInstallShellEnvHook } from "../keys/api-key.mjs";
import { verifyKeyExportWorks, printKeySelfCheckWarning } from "../keys/selfcheck.mjs";

/**
 * @param {string} home
 * @param {{ harnessId?: string, expectedKey?: string }} [options]
 */
export async function finishEnvHarnessOn(home, options = {}) {
  const shellConfig = await reconcileShellEnvHook(home);
  if (shellConfig) {
    console.log(`Run: source ${shellConfig}`);
  }

  // Best-effort: confirm the shell hook will actually be able to load the key
  // in a fresh shell (where FIREWORKS_API_KEY is not yet set). Non-fatal.
  // Skipped in test context to avoid subprocess overhead/flakiness in CI; the
  // self-check is exercised directly in test/secret-backend.test.mjs.
  const harnessId = options.harnessId ?? "this harness";
  const isTestContext = process.env.NODE_ENV === "test" || process.env.NEXUS_TEST === "1";
  const config = await readGlobalConfig(home);
  const needsShellExport = await needsFireworksShellExport(
    home,
    config.harnesses,
    shouldInstallShellEnvHook(config.apiKey),
  );
  if (!needsShellExport || isTestContext) {
    return;
  }
  try {
    const result = await verifyKeyExportWorks(home, { expectedKey: options.expectedKey });
    if (!result.ok) {
      printKeySelfCheckWarning(harnessId, result.reason ?? "unknown reason");
    }
  } catch (error) {
    printKeySelfCheckWarning(harnessId, error instanceof Error ? error.message : String(error));
  }
}
