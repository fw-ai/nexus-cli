import { isEnabledFireworksHarness, readGlobalConfig } from "../config/global-config.mjs";
import { autoProviderKeysInScope } from "../config/auto-providers.mjs";
import {
  anthropicKeyFromCustomHeaders,
  OPENAI_BYOK_HEADER,
  openaiKeyFromCustomHeaders,
} from "../firerouter/core.mjs";
import { HARNESS } from "../harness/id.mjs";
import { getHarness } from "../harness/registry.mjs";
import { userSettingsPath } from "../harnesses/claude/core.mjs";
import { OPENCODE_FIREWORKS_PROVIDER_ID, opencodeConfigPath } from "../harnesses/opencode/core.mjs";
import { isVscodeRunning } from "../harnesses/vscode/core.mjs";
import { readJsonIfExists } from "../io/json.mjs";
import { runHarnessCommand } from "../cli/commands/harness.mjs";
import { parseCli } from "../cli/parse-args.mjs";
import { AUTO_PROVIDER_KEYS } from "../keys/auto-provider-keys.mjs";

// Codex has its own upgrade re-`on` (codex/upgrade-reon.mjs), and Claude
// Desktop's shim reads the saved keys live, so neither is listed.
const TARGETS = [HARNESS.CLAUDE, HARNESS.OPENCODE, HARNESS.PI, HARNESS.COPILOT_CLI, HARNESS.DEEPSEEK, HARNESS.VSCODE];

/** "A", "A and B", "A, B and C". */
function joinLabels(labels) {
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
}

/**
 * The provider keys a connected harness's config carries right now.
 * @param {string} id
 * @param {string} home
 * @returns {Promise<{ anthropic: string, openai: string }>}
 */
async function harnessKeys(id, home) {
  let env;
  if (id === HARNESS.CLAUDE) {
    const settings = await readJsonIfExists(userSettingsPath(home)).catch(() => ({}));
    env = { ANTHROPIC_CUSTOM_HEADERS: settings.env?.ANTHROPIC_CUSTOM_HEADERS ?? "" };
  } else {
    const { ctx } = parseCli(["--home", home, id, "status"]);
    env = await getHarness(id).readByokEnv?.({ ...ctx, home }).catch(() => ({})) ?? {};
  }
  return {
    anthropic: anthropicKeyFromCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS),
    openai: env[OPENAI_BYOK_HEADER] ?? openaiKeyFromCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS),
  };
}

const LEGACY_ROUTER_HOST = "router.fireworks.ai";

/**
 * Whether Claude Code still points at the retired pre-0.9 FireRouter host
 * (`claude on --router` before FireConnect 0.9).
 * @param {string} home
 */
async function claudeOnLegacyRouter(home) {
  const settings = await readJsonIfExists(userSettingsPath(home)).catch(() => ({}));
  try {
    return new URL(settings.env?.ANTHROPIC_BASE_URL ?? "").hostname === LEGACY_ROUTER_HOST;
  } catch {
    return false;
  }
}

/**
 * Whether OpenCode is still in the pre-0.9 router mode: connected, but its
 * model is an `anthropic/...` model and the Nexus provider was never added.
 * (The upgrade's env-key migration already removed the router retarget.)
 * @param {string} home
 */
async function opencodeOnLegacyRouter(home) {
  const config = await readJsonIfExists(opencodeConfigPath(home, "")).catch(() => ({}));
  return typeof config.model === "string"
    && config.model.startsWith("anthropic/")
    && !config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
}

/**
 * Run `fn` with console output captured, so a re-`on` during the upgrade
 * prints only the upgrade's own note.
 * @param {() => Promise<unknown>} fn
 */
async function quietly(fn) {
  const { log, info } = console;
  console.log = () => {};
  console.info = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.info = info;
  }
}

/**
 * After an upgrade, re-run `nexus <harness> on` (the way a user would; it
 * keeps the current model) for connected harnesses an earlier release left
 * behind:
 * - keys saved for Nexus Auto that the harness should carry and doesn't yet
 *   (an earlier FireRouter migration strips provider headers, and keys saved
 *   with `nexus configure` were only sent on FireRouter);
 * - Claude Code or OpenCode still on the retired pre-0.9 FireRouter setup.
 * VS Code is skipped while it's open. Never throws.
 * @param {string} home
 * @param {{ run?: typeof runHarnessCommand, vscodeRunning?: () => boolean }} [deps]
 * @returns {Promise<string[]>}
 */
export async function reapplySavedProviderKeysOnUpgrade(home, { run = runHarnessCommand, vscodeRunning = isVscodeRunning } = {}) {
  if (!home) return [];
  try {
    const config = await readGlobalConfig(home);
    const saved = autoProviderKeysInScope(config);
    const savedByProvider = { anthropic: saved.anthropicKey, openai: saved.openaiKey };
    const updated = [];
    const movedOffRouter = [];
    const notes = [];
    for (const id of TARGETS) {
      if (!isEnabledFireworksHarness(config.harnesses, id)) continue;
      const harness = getHarness(id);
      const wanted = Object.keys(AUTO_PROVIDER_KEYS).filter((provider) => savedByProvider[provider]
        && AUTO_PROVIDER_KEYS[provider].ownSignIn !== id
        && AUTO_PROVIDER_KEYS[provider].reaches(harness));
      const present = wanted.length ? await harnessKeys(id, home) : null;
      const missingKeys = wanted.some((provider) => present[provider] !== savedByProvider[provider]);
      const legacyRouter = (id === HARNESS.CLAUDE && await claudeOnLegacyRouter(home))
        || (id === HARNESS.OPENCODE && await opencodeOnLegacyRouter(home));
      if (!missingKeys && !legacyRouter) continue;
      if (id === HARNESS.VSCODE && vscodeRunning()) {
        notes.push("Quit VS Code, then run nexus vscode so it sends the keys you saved for Nexus Auto.");
        continue;
      }
      try {
        const { route, ctx } = parseCli(["--home", home, id, "on", ...(id === HARNESS.VSCODE ? ["--force"] : [])]);
        await quietly(() => run(route, { ...ctx, quiet: true }));
        (legacyRouter ? movedOffRouter : updated).push(harness.label);
      } catch {
        notes.push(`Couldn't add your saved Nexus Auto keys to ${harness.label}. Run nexus ${id}.`);
      }
    }
    if (updated.length) {
      notes.unshift(`Added the keys you saved for Nexus Auto to ${joinLabels(updated)}. Restart ${updated.length > 1 ? "them" : "it"} to pick them up.`);
    }
    if (movedOffRouter.length) {
      notes.unshift(`Moved ${joinLabels(movedOffRouter)} off the retired FireRouter host (router.fireworks.ai) to Nexus Auto on Fireworks. Restart ${movedOffRouter.length > 1 ? "them" : "it"} to pick it up.`);
    }
    return notes;
  } catch {
    return [];
  }
}
