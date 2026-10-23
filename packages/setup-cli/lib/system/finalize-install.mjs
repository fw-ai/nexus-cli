import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { reconcileHarnessConfigOnUpgrade } from "../keys/sync.mjs";
import { reprobeKeyStorage } from "../keys/secret-store.mjs";
import { resolveFireworksApiKeyValue } from "../keys/api-key.mjs";
import { loadServerlessCatalog } from "../fireworks/models.mjs";
import { codexConfigPath } from "../harnesses/codex/core.mjs";
import { refreshCodexStockModels } from "../harnesses/codex/stock-models.mjs";
import { reapplyCodexOnUpgrade } from "../harnesses/codex/upgrade-reon.mjs";
import { isEnabledFireworksHarness, readGlobalConfig } from "../config/global-config.mjs";
import { HARNESS } from "../harness/id.mjs";
import { refreshListPriceCache } from "../pricing/list-price-cache.mjs";
import { hasForeignDataDir } from "./data-dir.mjs";
import { runRenameMigration } from "./rename-migration.mjs";
import { ensureCliDependencies, resolveSetupCliDir } from "./ensure-cli-deps.mjs";
import { formatNexusAutoMoves, isNexusAutoMoveNote, runHarnessForwardMigrations } from "./forward-migrations.mjs";
import { reapplySavedProviderKeysOnUpgrade } from "./provider-keys-upgrade.mjs";

/**
 * Refresh every model source the harness pickers are built from, before the
 * upgrade's harness steps rebuild them: the Fireworks serverless catalog,
 * models.dev (OpenAI and Anthropic models with their list prices), and stock
 * Codex's own model list when Codex is connected. They run together, each
 * bounded by its own timeout, and all are best-effort: offline keeps the
 * last-known snapshots, and a keyless install skips the serverless catalog.
 * @param {string} home
 * @returns {Promise<{ serverless: boolean, modelsDev: boolean, codex: boolean }>} which sources were refreshed
 */
export async function refreshModelSources(home) {
  const apiKey = (await resolveFireworksApiKeyValue({ home }).catch(() => "")).trim();
  const { harnesses } = await readGlobalConfig(home).catch(() => ({ harnesses: {} }));
  const [serverless, modelsDev, codex] = await Promise.all([
    apiKey
      ? loadServerlessCatalog({ apiKey, refresh: true }).then(() => true, () => false)
      : false,
    refreshListPriceCache({ force: true }),
    isEnabledFireworksHarness(harnesses, HARNESS.CODEX)
      ? refreshCodexStockModels({ codexHome: path.dirname(codexConfigPath(home)) })
      : false,
  ]);
  return { serverless, modelsDev, codex };
}

/**
 * Shared post-bootstrap repair for `install.sh` and `nexus update`.
 *
 * Bootstrap stays separate (bash clone vs git reset). Everything state-sensitive
 * after the CLI bits are on disk goes through this path:
 *   0. FireConnect → Nexus: move ~/.fireconnect to ~/.nexus and repoint the
 *      launcher, shell hooks, Claude's status line, and the Desktop shim
 *   1. ensure runtime npm deps
 *   2. re-probe secret storage / migrate plaintext → secure
 *   3. refresh the model sources: serverless catalog, models.dev, stock Codex (best-effort, silent)
 *   4. run key-independent harness migrations, then rebake keys / shell hook
 *   5. re-run `codex on` when Codex's config or GPT rows are out of date
 *
 * Never throws for reconcile/shell failures (best-effort). Dep install and
 * key-storage probe may throw only if callers choose to surface them — this
 * wrapper keeps probe/reconcile non-fatal for install.sh.
 *
 * @param {{
 *   home?: string,
 *   installDir?: string,
 *   setupDir?: string,
 *   log?: (...args: unknown[]) => void,
 *   ensureDeps?: typeof ensureCliDependencies,
 *   reprobe?: typeof reprobeKeyStorage,
 *   refreshCatalog?: typeof refreshModelSources,
 *   migrate?: typeof runHarnessForwardMigrations,
 *   reconcile?: typeof reconcileHarnessConfigOnUpgrade,
 *   codexSignIn?: typeof reapplyCodexOnUpgrade,
 *   providerKeys?: typeof reapplySavedProviderKeysOnUpgrade,
 *   rename?: typeof runRenameMigration,
 * }} [options]
 * @returns {Promise<{ notes: string[], migrated: boolean, setupDir: string, renameBlocked: boolean }>}
 */
export async function finalizeInstallOrUpgrade({
  home = process.env.HOME ?? "",
  installDir = home ? path.join(home, ".nexus/cli") : "",
  setupDir = "",
  log = console.log,
  ensureDeps = ensureCliDependencies,
  reprobe = reprobeKeyStorage,
  refreshCatalog = refreshModelSources,
  migrate = runHarnessForwardMigrations,
  reconcile = reconcileHarnessConfigOnUpgrade,
  codexSignIn = reapplyCodexOnUpgrade,
  providerKeys = reapplySavedProviderKeysOnUpgrade,
  rename = runRenameMigration,
} = {}) {
  const notes = [];
  const nexusAutoMoves = [];
  const emit = (note) => {
    if (isNexusAutoMoveNote(note)) {
      nexusAutoMoves.push(note);
      return;
    }
    log(note);
    notes.push(note);
  };
  for (const note of await rename(home)) {
    emit(note);
  }
  const durableSetup = installDir
    ? path.join(installDir, "packages/setup-cli")
    : "";
  const resolvedSetup = setupDir
    || (durableSetup && existsSync(path.join(durableSetup, "package.json"))
      ? durableSetup
      : resolveSetupCliDir());

  // A foreign ~/.nexus means the rename did not happen: every step below
  // resolves state under ~/.nexus and would read or write the other
  // program's files. Stop with just the rename's note.
  if (home && hasForeignDataDir(home)) {
    return { notes, migrated: false, setupDir: resolvedSetup, renameBlocked: true };
  }

  if (existsSync(path.join(resolvedSetup, "package.json"))) {
    ensureDeps(resolvedSetup);
  }

  let migrated = false;
  if (home) {
    try {
      const result = await reprobe(home);
      migrated = Boolean(result.migrated);
      if (migrated) {
        log(result.movedFrom === "file"
          ? "Moved the Fireworks API key from the encrypted-file fallback to the OS keychain."
          : "Moved Fireworks API key from plaintext fallback to secure storage.");
      } else if (result.backend?.backend === "plaintext") {
        log(
          "API key is still in the plaintext fallback (~/.nexus/.api-key); "
            + "secure storage is still unavailable on this host.",
        );
      }
    } catch {
      // Best-effort: install/upgrade must not abort after the CLI is already on disk.
    }

    try {
      await refreshCatalog(home);
    } catch {
      // Best-effort: an offline upgrade keeps serving the last-known snapshot.
    }

    try {
      for (const note of await migrate(home)) {
        emit(note);
      }
    } catch {
      // Best-effort forward migrations.
    }

    try {
      const reconcileNotes = await reconcile(home);
      for (const note of reconcileNotes) {
        emit(note);
      }
    } catch {
      // Best-effort reconcile.
    }


    // After the rebake, so a legacy env-reference config already holds a
    // literal key for the re-`on` to reuse.
    for (const note of await codexSignIn(home)) {
      emit(note);
    }

    for (const note of await providerKeys(home)) {
      emit(note);
    }
  }

  if (nexusAutoMoves.length) {
    const block = formatNexusAutoMoves(nexusAutoMoves);
    log(block);
    notes.push(block);
  }
  return { notes, migrated, setupDir: resolvedSetup, renameBlocked: false };
}
