import { userSettingsPath } from "../harnesses/claude/core.mjs";
import { refreshFirerouterClaudeKey, removeClaudeSavedProviderKeys } from "../harnesses/claude/firerouter.mjs";
import { codexConfigPath, refreshCodexGatewayKey } from "../harnesses/codex/core.mjs";
import {
  deepseekCredentialsPath,
  deepseekSettingsPath,
  refreshDeepseekGatewayKey,
} from "../harnesses/deepseek/core.mjs";
import {
  opencodeConfigPath,
  refreshOpencodeGatewayKey,
  removeOpencodeSavedProviderKeys,
} from "../harnesses/opencode/core.mjs";
import {
  piAuthPath,
  piModelsPath,
  refreshPiGatewayKey,
  removePiSavedProviderKeys,
} from "../harnesses/pi/core.mjs";
import {
  chatLanguageModelsPath,
  isVscodeRunning,
  refreshVscodeGatewayKey,
  removeVscodeSavedProviderKeys,
} from "../harnesses/vscode/core.mjs";
import {
  copilotDataDbPath,
  refreshCopilotAppGatewayKey,
} from "../harnesses/copilot-app/sqlite.mjs";
import {
  copilotProvidersPath,
  refreshCopilotCliGatewayKey,
} from "../harnesses/copilot-cli/config.mjs";
import {
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  isEnabledFireworksHarness,
  writeGlobalConfig,
} from "../config/global-config.mjs";
import { HARNESS } from "../harness/id.mjs";
import { reconcileShellEnvHook } from "../io/shell-env-hook.mjs";
import { resolveFireworksApiKeyValue, tryReadKeychainSecret } from "./api-key.mjs";
import { isEnvConfigRef, migrateLegacyGlobalApiKey } from "./config-ref.mjs";

/**
 * @param {import("../config/global-config.mjs").HarnessConfigMap} harnesses
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
function shouldSyncFireworksHarness(harnesses, harnessId) {
  return isEnabledFireworksHarness(harnesses, harnessId);
}

/**
 * Re-point every **enabled** Fireworks-routed harness config that holds the key
 * as a baked plaintext literal (or legacy env-reference) so a `login`/rotation
 * takes effect without re-running `on`.
 *
 * Codex: only `[model_providers.fireworks-ai]` auth is updated when the active
 * route is the Fireworks gateway (`refreshCodexGatewayKey`).
 *
 * `<harness> on` is the write path when enabling: it resolves the key, writes
 * the literal into the harness config, then marks the harness enabled.
 *
 * Returns user-facing notes per harness updated (or whose update failed).
 * Never throws.
 * @param {string} home
 * @param {string} fireworksKey
 * @returns {Promise<string[]>}
 */
export async function syncBakedKeysAfterStore(home, fireworksKey) {
  if (!home || !fireworksKey?.trim()) {
    return [];
  }
  const { harnesses } = await readGlobalConfig(home);
  const opencodeConfig = opencodeConfigPath(home, "");
  const codexConfig = codexConfigPath(home, "");
  const deepseekSettings = deepseekSettingsPath(home, "");
  const deepseekCredentials = deepseekCredentialsPath(home);
  const targets = [
    {
      id: HARNESS.CLAUDE,
      label: "Claude Code",
      hint: "nexus claude",
      refresh: () => refreshFirerouterClaudeKey({ settingsPath: userSettingsPath(home), fireworksKey }),
    },
    {
      id: HARNESS.CODEX,
      label: "Codex",
      hint: "nexus codex on",
      refresh: () => refreshCodexGatewayKey({ configPath: codexConfig, fireworksKey }),
    },
    {
      id: HARNESS.PI,
      label: "Pi",
      hint: "nexus pi on",
      refresh: () => refreshPiGatewayKey({ authPath: piAuthPath(home), fireworksKey }),
    },
    {
      id: HARNESS.OPENCODE,
      label: "OpenCode",
      hint: "nexus opencode on",
      refresh: () => refreshOpencodeGatewayKey({ configPath: opencodeConfig, fireworksKey }),
    },
    {
      id: HARNESS.DEEPSEEK,
      label: "DeepSeek Harness",
      hint: "nexus deepseek on",
      refresh: () => refreshDeepseekGatewayKey({
        settingsPath: deepseekSettings,
        credentialsPath: deepseekCredentials,
        fireworksKey,
      }),
    },
    {
      id: HARNESS.COPILOT_APP,
      label: "Copilot app",
      hint: "nexus copilot-app on",
      refresh: () => refreshCopilotAppGatewayKey({ dbPath: copilotDataDbPath({ home }), fireworksKey }),
    },
    {
      id: HARNESS.COPILOT_CLI,
      label: "Copilot CLI",
      hint: "nexus copilot-cli on",
      refresh: () => refreshCopilotCliGatewayKey({ providersPath: copilotProvidersPath({ home }), fireworksKey }),
    },
    {
      id: HARNESS.VSCODE,
      label: "VS Code",
      hint: "nexus vscode on",
      refresh: () => refreshVscodeGatewayKey({ vscodePath: chatLanguageModelsPath({ home }), fireworksKey }),
    },
  ];
  const notes = [];
  for (const { id, label, hint, refresh } of targets) {
    if (!shouldSyncFireworksHarness(harnesses, id)) {
      continue;
    }
    try {
      if (await refresh()) {
        notes.push(`Updated ${label}'s Fireworks settings with this key — restart ${label} to pick it up.`);
      }
    } catch {
      notes.push(`Couldn't update ${label}'s Fireworks settings — re-run ${hint} to use this key there.`);
    }
  }
  return notes;
}

/**
 * Remove saved provider keys (`x-anthropic-api-key`, `x-openai-api-key`) from
 * every enabled Fireworks harness that bakes them into its own config, so a
 * repeat `on` can't read them back. Never throws.
 *
 * `skipRunningIdes` leaves an IDE that is open alone (it rewrites its config
 * from memory and would drop the edit), reporting it in `skipped` only when
 * it still holds one of `headerNames`.
 * @param {string} home
 * @param {string[]} headerNames
 * @param {{ skipRunningIdes?: boolean, vscodeRunning?: () => boolean }} [options]
 * @returns {Promise<{ updated: string[], failed: { label: string, id: string }[], skipped: { label: string, id: string }[] }>}
 */
export async function removeSavedProviderKeysFromHarnesses(home, headerNames, {
  skipRunningIdes = false,
  vscodeRunning = isVscodeRunning,
} = {}) {
  const { harnesses } = await readGlobalConfig(home);
  const targets = [
    {
      id: HARNESS.CLAUDE,
      label: "Claude Code",
      remove: () => removeClaudeSavedProviderKeys({ settingsPath: userSettingsPath(home), headerNames }),
    },
    {
      id: HARNESS.OPENCODE,
      label: "OpenCode",
      remove: () => removeOpencodeSavedProviderKeys({ configPath: opencodeConfigPath(home, ""), headerNames }),
    },
    {
      id: HARNESS.PI,
      label: "Pi",
      remove: () => removePiSavedProviderKeys({ modelsPath: piModelsPath(home), headerNames }),
    },
    {
      id: HARNESS.VSCODE,
      label: "VS Code",
      remove: () => removeVscodeSavedProviderKeys({ filePath: chatLanguageModelsPath({ home }), headerNames }),
      pending: () => removeVscodeSavedProviderKeys({ filePath: chatLanguageModelsPath({ home }), headerNames, dryRun: true }),
      running: vscodeRunning,
    },
  ];
  const updated = [];
  const failed = [];
  const skipped = [];
  for (const { id, label, remove, pending, running } of targets) {
    if (!shouldSyncFireworksHarness(harnesses, id)) {
      continue;
    }
    try {
      if (skipRunningIdes && running?.()) {
        if (await pending()) {
          skipped.push({ id, label });
        }
        continue;
      }
      if (await remove()) {
        updated.push(label);
      }
    } catch {
      failed.push({ id, label });
    }
  }
  return { updated, failed, skipped };
}

/**
 * Post-upgrade key reconciliation: rebake every enabled Fireworks harness
 * config to plaintext literals (including legacy env-reference auth), repair
 * a stale global `{env:FIREWORKS_API_KEY}` ref when keychain holds the secret,
 * and reconcile the shell hook (dropping the legacy Codex provider-key exports).
 *
 * Key-independent harness migrations live in `system/forward-migrations.mjs`.
 * Never throws.
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function reconcileHarnessConfigOnUpgrade(home) {
  if (!home) {
    return [];
  }
  const notes = [];
  try {
    await migrateLegacyGlobalApiKey(home);
  } catch {
    // Best-effort: upgrade finalize must not abort after the git reset.
  }
  try {
    const fromKeychain = await tryReadKeychainSecret(home);
    if (fromKeychain) {
      const config = await readGlobalConfig(home);
      if (isEnvConfigRef(config.apiKey)) {
        await writeGlobalConfig(home, { apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF });
      }
    }
  } catch {
    // Best-effort config repair — rebake may still use the keychain secret directly.
  }
  let key = "";
  try {
    key = (await tryReadKeychainSecret(home))?.trim()
      || (await resolveFireworksApiKeyValue({ home }));
  } catch {
    return notes;
  }
  if (key) {
    notes.push(...await syncBakedKeysAfterStore(home, key));
  }
  try {
    await reconcileShellEnvHook(home);
  } catch {
    // Best-effort shell reconcile — never fail upgrade over ~/.bashrc I/O.
  }
  return notes;
}
