import process from "node:process";
import {
  AUTO_PROVIDER_IDS,
  AUTO_UNSUPPORTED_HARNESSES,
  autoHarnessSupported,
  autoProviderKeysInScope,
  autoScopeAllows,
  formatAutoProviders,
  parseAutoProviders,
} from "../../config/auto-providers.mjs";
import {
  listEnabledHarnesses,
  readGlobalConfig,
  writeGlobalConfig,
} from "../../config/global-config.mjs";
import {
  AUTO_PROVIDER_KEYS,
  autoProviderKeyReach,
  printAutoProviderKeyReach,
  promptForProviderKey,
  saveAutoProviderKeys,
  savedAutoProviderKeyStatus,
  unsetAutoProviderKeys,
} from "../../keys/auto-provider-keys.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { resolveFireworksKeyWithSource } from "../../keys/api-key.mjs";
import {
  getProviderKeysStatus,
  PROVIDER_KEYS_SETTINGS_URL,
  providerKeyStatusLine,
} from "../../keys/provider-keys-status.mjs";
import { accent } from "../../ui/term.mjs";
import { printNote, printSuccess } from "../messages.mjs";

/**
 * The `auto` router's current scope, for display and `--json`.
 * @param {{ providers: string[] | null }} auto
 */
export function describeAutoConfig(auto, keys = { anthropic: false, openai: false }) {
  const providers = auto?.providers ?? null;
  const config = { auto: { providers } };
  return {
    providers,
    keys,
    keysSent: {
      anthropic: keys.anthropic && autoScopeAllows(config, "anthropic"),
      openai: keys.openai && autoScopeAllows(config, "openai"),
    },
    fireworksOnly: providers?.length === 1 && providers[0] === "fireworks",
    behavior: providers?.length
      ? "auto routes only to the listed providers; your account's model restrictions always apply first"
      : providers
        ? "no providers sent: the stored scope names no recognized provider, so no scope and no saved provider keys are sent"
        : "default: Auto-selects the best model for each turn, based on your setup",
  };
}

/**
 * The one canonical statement of how this setting interacts with account
 * restrictions. CLI output renders it; help and the README mirror the
 * same words. Do not paraphrase it per surface.
 */
export const AUTO_ACCOUNT_RESTRICTIONS_LINE =
  "Your account's model restrictions always apply first";

function printAccountRestrictionsNote() {
  console.log(`  ${AUTO_ACCOUNT_RESTRICTIONS_LINE}`);
}

function printReonSteps(harnesses) {
  const supported = harnesses.filter(autoHarnessSupported);
  const unsupported = AUTO_UNSUPPORTED_HARNESSES.filter(({ id }) => harnesses.includes(id));
  console.log("  One more step: this takes effect only once you run your");
  console.log("  harness command again, for each harness you use:");
  if (supported.length) {
    for (const id of supported) {
      console.log(`    ${accent(`nexus ${id}`)}`);
    }
  } else if (!unsupported.length) {
    console.log(`    ${accent("nexus <harness>")}`);
  }
  if (unsupported.length) {
    const names = unsupported.map(({ label }) => label).join(", ");
    console.log("");
    console.log(`  Not yet supported on ${names}: auto there isn't`);
    console.log("  narrowed by this setting, so there's nothing to re-run.");
  }
}

/**
 * After saving a key: the connected harnesses that need `nexus <harness>`
 * again to pick it up. Claude Desktop reads it live through its local shim.
 * @param {string[]} harnesses connected harnesses that can send the key
 */
function printKeyReonSteps(harnesses) {
  const reon = harnesses.filter((id) => id !== HARNESS.CLAUDE_DESKTOP);
  if (reon.length) {
    console.log("  Run your harness command again so it sends the key:");
    for (const id of reon) {
      console.log(`    ${accent(`nexus ${id}`)}`);
    }
  }
  if (harnesses.includes(HARNESS.CLAUDE_DESKTOP)) {
    console.log("  Claude Desktop picks it up on its next request.");
  }
}

function unsupportedSentence(harnesses) {
  const labels = AUTO_UNSUPPORTED_HARNESSES
    .filter(({ id }) => harnesses.includes(id))
    .map(({ label }) => label);
  if (!labels.length) {
    return null;
  }
  const names = labels.length > 1
    ? `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}`
    : labels[0];
  return `This setting is not yet supported by ${names}`;
}

function keyStatus(saved, sent, providers) {
  if (!saved) return "not set";
  if (sent) return "saved";
  return providers?.length
    ? `saved, not sent while auto is limited to ${formatAutoProviders(providers)}`
    : "saved, not sent (the stored scope names no recognized provider)";
}

/**
 * Account Provider Key state for the display path. Resolving the Fireworks
 * key is justified here: `nexus auto` is the screen that reports how Nexus
 * Auto gets its credentials. Any failure reads as a one-line outcome, so
 * the screen never hangs or throws offline or signed out.
 * @param {string} home
 */
async function readProviderKeysStatus(home) {
  try {
    const { key } = await resolveFireworksKeyWithSource({ apiKey: "", home });
    return await getProviderKeysStatus({ apiKey: key });
  } catch {
    return {
      outcome: "unavailable",
      accountId: "",
      providers: {
        anthropic: { state: "not-connected", keyHint: "" },
        openai: { state: "not-connected", keyHint: "" },
      },
      reason: "",
    };
  }
}

function printProviderKeys(status, keys, keysSent) {
  console.log("  Provider Keys (your Fireworks account):");
  console.log(`    Anthropic: ${providerKeyStatusLine(status, "anthropic")}`);
  console.log(`    OpenAI:    ${providerKeyStatusLine(status, "openai")}`);
  if (status?.outcome === "ok") {
    const overridden = ["anthropic", "openai"].filter((provider) => (
      status.providers[provider].state === "connected" && keys[provider] && keysSent[provider]
    ));
    if (overridden.length) {
      console.log("    A saved local key overrides the Provider Key for that provider.");
    }
    console.log(`    Manage keys: ${PROVIDER_KEYS_SETTINGS_URL}`);
  }
  console.log("");
}

function printCurrent(auto, harnesses, keys, providerKeys) {
  const { providers, keysSent } = describeAutoConfig(auto, keys);
  console.log("Auto router");
  console.log("");
  console.log(`  Providers:      ${providers?.length ? formatAutoProviders(providers) : providers ? "none sent" : "default"}`);
  console.log("");
  console.log("  Local keys (this machine):");
  console.log(`  Anthropic key:  ${keyStatus(keys.anthropic, keysSent.anthropic, providers)}`);
  console.log(`  OpenAI key:     ${keyStatus(keys.openai, keysSent.openai, providers)}`);
  console.log("");
  printProviderKeys(providerKeys, keys, keysSent);
  if (providers?.length) {
    console.log("  Auto will route only to the providers above.");
  } else if (providers) {
    console.log("  The stored scope names no recognized provider, so no scope and no saved provider keys are sent. Run `nexus auto --reset` to restore the default.");
  } else {
    console.log("  Auto-selects the best model for each turn, based on your setup.");
  }
  console.log("");
  console.log("  Tips:");
  if (!providers?.length) {
    console.log(`  - Limit the models to Fireworks-only with ${accent("nexus auto --providers fireworks")}`);
  } else {
    console.log(`  - Name the providers explicitly with ${accent(`nexus auto --providers ${AUTO_PROVIDER_IDS.join(",")}`)}`);
  }
  console.log(`  - ${AUTO_ACCOUNT_RESTRICTIONS_LINE}`);
  const unsupported = unsupportedSentence(harnesses);
  if (unsupported) {
    console.log(`  - ${unsupported}`);
  }
  if (!providers?.length && (!keys.anthropic || !keys.openai)) {
    console.log(`  - Let auto use Anthropic or OpenAI models with your own key: ${accent("nexus auto --anthropic-api-key") + " and paste at the prompt"}`);
  }
  console.log(`  - To reset, use ${accent("nexus auto --reset")}`);
  if (providers?.length) {
    console.log("");
    printReonSteps(harnesses);
  }
}

/**
 * `nexus auto` customizes the `auto` router itself (harness-agnostic), so
 * it is not part of `configure` (credential/endpoint plumbing) and takes
 * no per-harness flags. This command only stores the scope; the steps are
 * run it, then re-`on` each harness so the new scope takes effect there.
 * The scope only ever narrows: account-level restrictions always apply
 * first and are never widened by anything stored here.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runAutoCommand(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }
  if (ctx.main || ctx.opus || ctx.sonnet || ctx.haiku || ctx.fable || ctx.subagent) {
    throw new Error("`nexus auto` customizes the auto router; choose it per harness with `nexus <harness> on --model auto`.");
  }
  if (ctx.apiKeyFromFlag || ctx.azure || ctx.provider) {
    throw new Error("Fireworks keys and endpoints belong to `nexus login` and `nexus configure`; `nexus auto` sets the providers and the Anthropic and OpenAI keys the auto router may use.");
  }

  const wantsProviders = Boolean(ctx.providersFromFlag);
  if (ctx.autoReset && wantsProviders) {
    throw new Error("--reset cannot be combined with --providers.");
  }
  const unsetProviders = [ctx.unsetAnthropicKey && "anthropic", ctx.unsetOpenaiKey && "openai"].filter(Boolean);
  const setAlongside = unsetProviders.find((name) =>
    name === "anthropic" ? ctx.anthropicKeyFromFlag : ctx.openaiKeyFromFlag);
  if (setAlongside) {
    const { flag } = AUTO_PROVIDER_KEYS[setAlongside];
    throw new Error(`${flag} and --unset ${flag.slice(2)} cannot be used together.`);
  }
  // Validate the scope before asking for a key, so a typo doesn't cost a paste.
  const providers = wantsProviders ? parseAutoProviders(ctx.providers) : null;
  if (ctx.anthropicKeyPrompt || ctx.openaiKeyPrompt) {
    if (ctx.json) {
      const { flag } = AUTO_PROVIDER_KEYS[ctx.anthropicKeyPrompt ? "anthropic" : "openai"];
      throw new Error(`${flag} requires a value`);
    }
    if (ctx.anthropicKeyPrompt) {
      ctx.anthropicKey = await promptForProviderKey("anthropic");
    }
    if (ctx.openaiKeyPrompt) {
      ctx.openaiKey = await promptForProviderKey("openai");
    }
  }
  const wantsKeys = Boolean(ctx.anthropicKeyFromFlag || ctx.openaiKeyFromFlag);

  if (wantsKeys || unsetProviders.length) {
    const saved = await saveAutoProviderKeys(home, {
      anthropic: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
      openai: ctx.openaiKeyFromFlag ? ctx.openaiKey : "",
    });
    if (unsetProviders.length) {
      await unsetAutoProviderKeys(home, unsetProviders, { stderr: ctx.json });
    }
    if (!ctx.json) {
      const config = await readGlobalConfig(home);
      const scope = providers ?? (ctx.autoReset ? null : config.auto.providers);
      const sendable = saved.filter((provider) => autoScopeAllows({ auto: { providers: scope } }, provider));
      for (const provider of saved) {
        printSuccess(`Saved the ${AUTO_PROVIDER_KEYS[provider].label} key for Nexus Auto.`);
        if (sendable.includes(provider)) {
          printAutoProviderKeyReach(provider);
        } else {
          console.log(scope?.length
            ? `  Auto is limited to ${formatAutoProviders(scope)}, so Nexus doesn't send it. Run ${accent("nexus auto --reset")} to let auto use it.`
            : `  The stored scope names no recognized provider, so Nexus doesn't send it. Run ${accent("nexus auto --reset")} to let auto use it.`);
        }
      }
      if (saved.length) {
        printNote("Saved to ~/.nexus/config.json");
      }
      if (sendable.length && !wantsProviders && !ctx.autoReset) {
        printKeyReonSteps(listEnabledHarnesses(config.harnesses).filter((id) =>
          sendable.some((provider) => autoProviderKeyReach(provider).sends.some((harness) => harness.id === id))));
      }
      if (!wantsProviders && !ctx.autoReset) {
        return;
      }
    }
  }

  const config = await readGlobalConfig(home);
  const harnesses = listEnabledHarnesses(config.harnesses);
  const keys = savedAutoProviderKeyStatus(config);

  if (!wantsProviders && !ctx.autoReset) {
    const providerKeys = await readProviderKeysStatus(home);
    if (ctx.json) {
      console.log(JSON.stringify({
        ...describeAutoConfig(config.auto, keys),
        providerKeys: {
          outcome: providerKeys.outcome,
          anthropic: providerKeys.providers.anthropic,
          openai: providerKeys.providers.openai,
        },
      }, null, 2));
      return;
    }
    printCurrent(config.auto, harnesses, keys, providerKeys);
    return;
  }

  await writeGlobalConfig(home, { auto: { providers } });

  if (ctx.json) {
    console.log(JSON.stringify(describeAutoConfig({ providers }, keys), null, 2));
    return;
  }

  const savedKeyLabels = ["anthropic", "openai"].filter((provider) => keys[provider])
    .map((provider) => AUTO_PROVIDER_KEYS[provider].label);
  const heldBack = savedKeyLabels.length && !ctx.autoReset
    && Object.values(autoProviderKeysInScope({ ...config, auto: { providers } })).every((key) => !key);
  if (ctx.autoReset) {
    printSuccess("Auto router is back to the default.");
    console.log("  Auto-selects the best model for each turn, based on your setup.");
    if (savedKeyLabels.length) {
      console.log(`  Your saved ${savedKeyLabels.join(" and ")} ${savedKeyLabels.length > 1 ? "keys are" : "key is"} sent again once you re-run your harness.`);
    }
  } else {
    printSuccess(`Auto router providers saved: ${formatAutoProviders(providers)}`);
    printAccountRestrictionsNote();
    if (heldBack) {
      console.log(`  Your saved ${savedKeyLabels.join(" and ")} ${savedKeyLabels.length > 1 ? "keys stay" : "key stays"} saved but ${savedKeyLabels.length > 1 ? "aren't" : "isn't"} sent while auto is limited to ${formatAutoProviders(providers)}.`);
    }
  }
  printNote("Saved to ~/.nexus/config.json");
  printReonSteps(harnesses);
}
