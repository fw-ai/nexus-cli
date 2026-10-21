import process from "node:process";
import {
  AUTO_PROVIDER_IDS,
  AUTO_UNSUPPORTED_HARNESSES,
  autoHarnessSupported,
  formatAutoProviders,
  parseAutoProviders,
} from "../../config/auto-providers.mjs";
import {
  listEnabledHarnesses,
  readGlobalConfig,
  writeGlobalConfig,
} from "../../config/global-config.mjs";
import { accent } from "../../ui/term.mjs";
import { printNote, printSuccess } from "../messages.mjs";

/**
 * The `auto` router's current scope, for display and `--json`.
 * @param {{ providers: string[] | null }} auto
 */
export function describeAutoConfig(auto) {
  const providers = auto?.providers ?? null;
  return {
    providers,
    fireworksOnly: providers?.length === 1 && providers[0] === "fireworks",
    behavior: providers?.length
      ? "auto routes only to the listed providers; your account's model restrictions always apply first"
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

function printCurrent(auto, harnesses) {
  const { providers } = describeAutoConfig(auto);
  console.log("Auto router");
  console.log("");
  if (providers?.length) {
    console.log(`  Providers:  ${formatAutoProviders(providers)}`);
    console.log("");
    console.log("  Auto will route only to the providers above.");
  } else {
    console.log("  Providers:  default");
    console.log("");
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
  if (ctx.apiKeyFromFlag || ctx.anthropicKeyFromFlag || ctx.openaiKeyFromFlag || ctx.azure || ctx.provider || ctx.unsetAnthropicKey || ctx.unsetOpenaiKey) {
    throw new Error("Provider keys and endpoints belong to `nexus configure`; `nexus auto` only sets which providers the auto router may use.");
  }

  const wantsProviders = Boolean(ctx.providersFromFlag);
  if (ctx.autoReset && wantsProviders) {
    throw new Error("--reset cannot be combined with --providers.");
  }

  const config = await readGlobalConfig(home);
  const harnesses = listEnabledHarnesses(config.harnesses);

  if (!wantsProviders && !ctx.autoReset) {
    if (ctx.json) {
      console.log(JSON.stringify(describeAutoConfig(config.auto), null, 2));
      return;
    }
    printCurrent(config.auto, harnesses);
    return;
  }

  const providers = ctx.autoReset ? null : parseAutoProviders(ctx.providers);
  await writeGlobalConfig(home, { auto: { providers } });

  if (ctx.json) {
    console.log(JSON.stringify(describeAutoConfig({ providers }), null, 2));
    return;
  }

  if (ctx.autoReset) {
    printSuccess("Auto router is back to the default.");
    console.log("  Auto-selects the best model for each turn, based on your setup.");
  } else {
    printSuccess(`Auto router providers saved: ${formatAutoProviders(providers)}`);
    printAccountRestrictionsNote();
  }
  printNote("Saved to ~/.nexus/config.json");
  printReonSteps(harnesses);
}
