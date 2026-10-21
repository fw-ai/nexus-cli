import {
  printHarnessConnected,
  printNote,
  printRestartHint,
} from "../../cli/messages.mjs";
import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  isFirerouterModelPattern,
} from "../../fireworks/model-id.mjs";
import {
  loadRegisterableModels,
} from "../../fireworks/models.mjs";
import { isFireworksKey } from "../../keys/key-type.mjs";
import {
  CURSOR_FIREWORKS_BASE_URL,
  CURSOR_DEFAULT_MODE,
  CURSOR_FIREWORKS_ONLY_NOTE,
  ensureCursorStopped,
  cursorCurrentModelId,
  cursorProviderStatus,
  disableCursorFireworks,
  enableCursorAzure,
  enableCursorFireworks,
  fireconnectRegisteredModels,
  readCursorState,
  relocateLegacyCursorBackups,
} from "./core.mjs";
import { DEFAULT_AZURE_MODEL } from "../../fireworks/azure-core.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  cursorPathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { isHarnessEnabled, readProviderSettings } from "../../config/global-config.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import {
  linuxSafeStorageIsObfuscatedFallback,
  linuxSafeStorageObfuscatedKeyNote,
  secretEncryptionUnavailableMessage,
} from "../vscode/safestorage.mjs";

const CURSOR_FIREROUTER_AZURE_UNSUPPORTED =
  "FireRouter is not supported in Cursor Azure mode.";

// Cursor can't forward a local Anthropic BYOK key (byok: "none"), so an
// Anthropic-requiring firerouter selection simply runs without BYOK headers:
// FireRouter keeps routing the Fireworks mix instead of failing the connect.
function rejectCursorFirerouterAzure() {
  throw new Error(CURSOR_FIREROUTER_AZURE_UNSUPPORTED);
}

/**
 * Harness-local Fireworks key for Cursor: the OpenAI key cell in state.vscdb.
 * Returns "" when none is present.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function cursorResolveKey(ctx) {
  const { dbPath } = cursorPathsFor(ctx);
  const { openAIKey } = await readCursorState(dbPath);
  return isFireworksKey(openAIKey) ? openAIKey.trim() : "";
}

async function isCursorAzureOnRequest(ctx) {
  if (ctx.azure === true || ctx.provider === "azure") {
    return true;
  }
  const home = ctx.home?.trim() ?? "";
  if (!home) {
    return false;
  }
  const { provider } = await readProviderSettings(home);
  return provider === "azure";
}

async function cursorResolveOnContext(ctx) {
  if (!isFirerouterModelPattern(ctx.main)) {
    return ctx;
  }
  if (await isCursorAzureOnRequest(ctx)) {
    rejectCursorFirerouterAzure();
  }
  return ctx;
}

export default defineHarnessProfile({
  id: HARNESS.CURSOR,
  label: "Cursor",
  resolveKey: cursorResolveKey,
  resolveOnContext: cursorResolveOnContext,
  keyEnvRef: "${FIREWORKS_API_KEY}",
  getExistingHarnessKey: cursorResolveKey,
  paths: (ctx) => cursorPathsFor(ctx),
  // Cursor's override UI can't attach local BYOK headers, so only
  // pure-Fireworks firerouter paths (no Anthropic model in them) are usable.
  firerouter: {
    byok: "none",
    autoCatalog: true,
  },
  azure: {
    read: async (_ctx, { dbPath }) => {
      const { blob, openAIKey } = await readCursorState(dbPath);
      return {
        active: cursorProviderStatus(blob, openAIKey) === "azure",
        storedKey: openAIKey,
        storedBaseUrl: typeof blob.openAIBaseUrl === "string" ? blob.openAIBaseUrl : "",
        model: cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE) || DEFAULT_AZURE_MODEL,
      };
    },
    enable: async ({ ctx, paths, apiKey, baseUrl }) => {
      if (isFirerouterModelPattern(ctx.main)) {
        rejectCursorFirerouterAzure();
      }
      await relocateLegacyCursorBackups({ home: ctx.home, dataDir: paths.dataDir });
      await ensureCursorStopped({ force: ctx.force });
      return enableCursorAzure({
        dbPath: paths.dbPath,
        dataDir: paths.dataDir,
        apiKey,
        baseUrl,
        modelId: ctx.main,
      });
    },
    restart: () => printRestartHint("Quit & reopen Cursor IDE for the change to take effect."),
  },
  enable: async ({ ctx, paths, effectiveKey, modelId, includeFirerouter = false }) => {
    // Register the preferred catalog; firerouter registers only when explicitly requested. A
    // TTL-cached snapshot serves offline; a cold start with no network must
    // fail the `on` rather than register from an empty model list. When no
    // catalog entries are available at all, treat it as unavailable so a
    // previous online run's registered models are trusted instead of wiped.
    const { ids: extraModels, available: catalogAvailable } = await loadRegisterableModels({
      apiKey: effectiveKey,
      includeFirerouter,
    });
    await relocateLegacyCursorBackups({ home: ctx.home, dataDir: paths.dataDir });
    await ensureCursorStopped({ force: ctx.force });
    return enableCursorFireworks({
      dbPath: paths.dbPath,
      dataDir: paths.dataDir,
      apiKey: effectiveKey,
      modelId,
      extraModels,
      catalogUnavailable: !catalogAvailable,
    });
  },
  printConnected: ({ result }) => {
    printHarnessConnected("Cursor", { model: result.model });
    if (result.replacedModel) {
      printNote(`Built-in "${result.replacedModel}" isn't on Fireworks — switched to ${result.model}.`);
    }
    printNote(CURSOR_FIREWORKS_ONLY_NOTE);
    if (linuxSafeStorageIsObfuscatedFallback()) {
      printNote(
        "Note: no Secret Service (libsecret) was detected for Cursor's Electron safeStorage on this Linux host, "
          + "so Cursor will obfuscate (not encrypt) the stored key. Install gnome-keyring + secret-service for real encryption. "
          + "(Nexus's own API key storage shown in `nexus status` is separate.)",
      );
    } else if (result.obfuscatedKey) {
      printNote(linuxSafeStorageObfuscatedKeyNote("cursor"));
    }
    if (result.encrypted === false) {
      // The encrypted `secret://` key cell couldn't be written (Cursor's Safe
      // Storage key isn't in the OS keychain yet — usually means Cursor hasn't
      // been launched). Only the legacy plaintext cell was written, which older
      // Cursor reads but modern Cursor ignores, so the key won't take effect on
      // a modern build until Cursor has created its Safe Storage key.
      printNote(`Warning: ${secretEncryptionUnavailableMessage("cursor")}`);
    }
  },
  restartHint: () => printRestartHint("Quit & reopen Cursor IDE for the change to take effect."),

  // Cursor stores its key in a SQLite secret (no shell env hook), and must be
  // stopped before writing.
  envHookOff: false,
  prepareOff: (ctx) => ensureCursorStopped({ force: ctx.force }),
  disable: async ({ ctx, paths, wasEnabled }) => {
    await relocateLegacyCursorBackups({ home: ctx.home, dataDir: paths.dataDir });
    return disableCursorFireworks({
      dbPath: paths.dbPath,
      dataDir: paths.dataDir,
      wasEnabled,
    });
  },
  restartHintOff: () => printRestartHint("Quit & reopen Cursor IDE for full effect."),
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CURSOR);
    const paths = cursorPathsFor(ctx);
    await relocateLegacyCursorBackups({ home: ctx.home, dataDir: paths.dataDir });
    const { blob, openAIKey } = await readCursorState(paths.dbPath);
    return cursorProviderStatus(blob, openAIKey);
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CURSOR);
    const paths = cursorPathsFor(ctx);
    await relocateLegacyCursorBackups({ home: ctx.home, dataDir: paths.dataDir });
    const { dbPath } = paths;
    const enabled = await isHarnessEnabled(ctx.home, HARNESS.CURSOR);
    const { blob, openAIKey } = await readCursorState(dbPath);
    const provider = cursorProviderStatus(blob, openAIKey);
    const baseUrl = blob.openAIBaseUrl ?? null;

    if (provider === "azure") {
      const deployment = cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE)
        || (fireconnectRegisteredModels(blob)[0] ?? null);
      const payload = {
        harness: HARNESS.CURSOR,
        enabled,
        provider: "azure",
        baseUrl,
        modelProvider: "fireworks-azure",
        hasKey: Boolean(openAIKey),
        defaults: { main: DEFAULT_AZURE_MODEL },
        current: { main: deployment },
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printStructuredHarnessStatus(HARNESS.CURSOR, {
        provider: payload.provider,
        keyConfigured: payload.hasKey,
        authMode: "literal",
        model: payload.current.main,
        endpoint: payload.baseUrl,
      });
      return;
    }

    const keyType = provider === "none" ? "none" : "fireworks";
    const registered = fireconnectRegisteredModels(blob);

    const payload = {
      harness: HARNESS.CURSOR,
      enabled,
      provider,
      baseUrl,
      useOpenAIKey: Boolean(blob.useOpenAIKey),
      hasKey: Boolean(openAIKey),
      keyType,
      registeredModels: registered,
      current: {
        main: cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE) || null,
      },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.CURSOR, {
      provider: payload.provider,
      keyConfigured: payload.hasKey,
      authMode: "literal",
      model: payload.current.main === "default" ? null : payload.current.main,
      registeredModels: registered,
      keySource: harnessStatusKeySource(HARNESS.CURSOR, provider, { whenFireworks: false }),
    });
  },
});
