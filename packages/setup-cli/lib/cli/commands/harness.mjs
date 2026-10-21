import process from "node:process";
import { dispatchHarnessCommand } from "../../harness/types.mjs";
import { getHarness } from "../../harness/registry.mjs";
import { persistGlobalAnthropicApiKey, persistGlobalOpenaiApiKey } from "../../config/global-config.mjs";
import { FILE_CONFIG_HARNESS_SET, HARNESS } from "../../harness/id.mjs";
import { PROVIDER_KEYS_DOCS_URL } from "../messages.mjs";
import { assertNotFirerouterModelId, isFirerouterModelPattern } from "../../fireworks/model-id.mjs";
import { isAnthropicShapedKey, isOpenAIShapedKey } from "../../firerouter/core.mjs";
import { supportsAnthropicApiKeyFlag, supportsOpenaiApiKeyFlag } from "../../firerouter/flag.mjs";
import {
  assertFireworksKeyUsable,
  assertFireworksKeyShape,
  assertNoFireworksEnvForStorage,
  canPersistApiKeyToKeychain,
  persistApiKeyFromFlag,
  persistApiKeyToKeychain,
} from "../../keys/api-key.mjs";
import { shouldSkipEnvKeyAutoPersist } from "../../config/secret-storage-policy.mjs";

const IDE_HARNESSES = new Set([HARNESS.CURSOR, HARNESS.VSCODE, HARNESS.CODEX, HARNESS.COPILOT_APP]);

// Provider-key flags a harness refuses, with what to do instead: its own sign-in
// pays for that provider's models, or the key belongs on the Fireworks account.
const REFUSED_KEY_FLAGS = Object.freeze({
  [HARNESS.CLAUDE]: {
    anthropic: "Claude Code pays for Claude turns with its own sign-in. Run `claude login`, or export "
      + "ANTHROPIC_API_KEY to pay with an Anthropic key. For Claude on other harnesses, run "
      + `\`nexus configure --anthropic-api-key <key>\` or add a Provider Key: ${PROVIDER_KEYS_DOCS_URL}.`,
  },
  [HARNESS.CODEX]: {
    anthropic: "Codex doesn't send an Anthropic key. For Claude in a FireRouter route, add an Anthropic "
      + `Provider Key on your Fireworks account: ${PROVIDER_KEYS_DOCS_URL}. To save the key for other `
      + "harnesses, run `nexus configure --anthropic-api-key <key>`.",
    openai: "Codex pays for GPT turns with its own sign-in. To pay with an OpenAI key, sign Codex in "
      + "with it: `codex login --with-api-key`.",
  },
});

/**
 * Fail on parsed flags the selected harness/command cannot use. The parser is
 * intentionally shared, but silently ignoring a valid-looking option is worse
 * than an immediate command-specific recovery message.
 * @param {{ harnessId: string, verb: string, noun?: string }} route
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
function validateHarnessOptions(route, ctx) {
  const { harnessId, verb, noun = "" } = route;
  const isOn = verb === "on" && !noun;
  const onboardingMode = ctx.onboardingMode ?? "auto";
  const claudeAliases = [ctx.opus, ctx.sonnet, ctx.haiku, ctx.fable, ctx.subagent];
  const claudeModels = [ctx.main, ...claudeAliases];
  const firerouterRequested = harnessId === HARNESS.CLAUDE
    ? claudeModels.some((modelId) => isFirerouterModelPattern(modelId))
    : isFirerouterModelPattern(ctx.main);

  if (isOn) {
    // FireRouter routes are retired as a selection: reject any `firerouter*`
    // pattern the user is asking to store, on every harness, before keys are
    // persisted or any config is written. Stored FireRouter selections from
    // earlier releases are handled by the upgrade/re-`on` migration instead.
    const supplied = harnessId === HARNESS.CLAUDE
      ? [
        ["--model", ctx.main],
        ["--opus", ctx.opus],
        ["--sonnet", ctx.sonnet],
        ["--haiku", ctx.haiku],
        ["--fable", ctx.fable],
        ["--subagent", ctx.subagent],
      ]
      : [["--model", ctx.main]];
    for (const [flag, modelId] of supplied) {
      assertNotFirerouterModelId(modelId ?? "", flag);
    }
  }

  if (isOn && harnessId !== HARNESS.CLAUDE && /\[1m\]$/i.test(ctx.main?.trim() ?? "")) {
    throw new Error("[1m] model suffixes are only supported by Claude Code.");
  }

  if (ctx.provider && !ctx.azure) {
    throw new Error(
      "--provider is configure-only. For a one-off harness switch, use --azure; "
        + "to change the default, run: nexus configure --provider <fireworks|azure>",
    );
  }
  if (ctx.azure && harnessId === HARNESS.CLAUDE) {
    throw new Error("Claude does not support Azure mode; omit --azure to use the Fireworks gateway.");
  }
  if (ctx.baseUrlFromFlag && harnessId !== HARNESS.CLAUDE && !ctx.azure) {
    throw new Error("--base-url on this harness requires --azure.");
  }
  if (ctx.force && !IDE_HARNESSES.has(harnessId)) {
    throw new Error("--force is only supported for Cursor, VS Code, the Copilot app, and Codex.");
  }
  if (onboardingMode === "prompt" && harnessId === HARNESS.CLAUDE && isOn) {
    throw new Error(
      "--interactive is not supported for Claude Code. Use `--model <id>` to choose a Fireworks "
        + "model and add it to the /model picker.",
    );
  }
  if (onboardingMode !== "auto" && !(harnessId === HARNESS.CLAUDE && isOn)) {
    const flag = onboardingMode === "prompt" ? "--interactive" : "--non-interactive";
    throw new Error(`${flag} applies only to \`nexus claude on\`.`);
  }
  if (claudeAliases.some(Boolean) && !(harnessId === HARNESS.CLAUDE && isOn)) {
    throw new Error("--opus/--sonnet/--haiku/--fable/--subagent apply only to `nexus claude on`.");
  }
  if (ctx.main && !isOn) {
    throw new Error("--model applies only to `<harness> on`.");
  }
  if (ctx.search) {
    throw new Error("--search applies only to `nexus model list`.");
  }
  if (ctx.refresh) {
    throw new Error("--refresh applies only to `nexus model list`.");
  }
  // `--session` is shared by `claude usage` (report) and `claude live` (resume +
  // meter that session in the split); the report-only flags stay usage-only.
  const sessionAllowed = harnessId === HARNESS.CLAUDE && !noun
    && (verb === "usage" || verb === "live");
  if (ctx.session && !sessionAllowed) {
    throw new Error("--session applies only to `nexus claude usage` or `nexus claude live`.");
  }
  const hasUsageOption = Boolean(ctx.days || ctx.lastN || ctx.verbose || ctx.plain);
  if (hasUsageOption && !(harnessId === HARNESS.CLAUDE && verb === "usage" && !noun)) {
    throw new Error("--days/--last-n/--verbose/--plain apply only to `nexus claude usage`.");
  }
  if (verb === "live" && harnessId !== HARNESS.CLAUDE) {
    throw new Error("`nexus <harness> live` is supported only for Claude Code.");
  }
  const jsonSupported = verb === "status"
    || verb === "usage";
  if (ctx.json && !jsonSupported) {
    throw new Error("--json is supported by status and Claude usage.");
  }

  if (ctx.settingsPath && harnessId !== HARNESS.CLAUDE && harnessId !== HARNESS.PI) {
    throw new Error("--settings-path is supported only by Claude and Pi.");
  }
  if (ctx.configPath && !FILE_CONFIG_HARNESS_SET.has(harnessId)) {
    throw new Error("--config-path is supported only by OpenCode, Codex, Pi, and DeepSeek Harness.");
  }
  if (ctx.dbPath && harnessId !== HARNESS.CURSOR && harnessId !== HARNESS.COPILOT_APP) {
    throw new Error("--db-path is supported only by Cursor and the Copilot app.");
  }
  if (ctx.vscodePath && harnessId !== HARNESS.VSCODE) {
    throw new Error("--vscode-path is supported only by VS Code.");
  }
  if (ctx.providersPath && harnessId !== HARNESS.COPILOT_CLI) {
    throw new Error("--providers-path is supported only by the Copilot CLI.");
  }
  if (ctx.unsetAnthropicKey || ctx.unsetOpenaiKey) {
    throw new Error("To clear a saved provider key, run `nexus configure --unset openai-api-key` (or `--unset anthropic-api-key`).");
  }
  if (ctx.anthropic || ctx.openai || ctx.storedOnly || ctx.withToken || ctx.revoke || ctx.paste || ctx.account) {
    throw new Error("This option belongs to a global login/logout/key command, not a harness command.");
  }

  const refusedKeyFlags = REFUSED_KEY_FLAGS[harnessId];
  if (ctx.anthropicKeyFromFlag && refusedKeyFlags?.anthropic) {
    throw new Error(refusedKeyFlags.anthropic);
  }
  if (ctx.openaiKeyFromFlag && refusedKeyFlags?.openai) {
    throw new Error(refusedKeyFlags.openai);
  }
  if (ctx.anthropicKeyFromFlag) {
    // The flag only ever served FireRouter routes, which are retired.
    if (!isOn || !firerouterRequested) {
      throw new Error(
        "--anthropic-api-key was for FireRouter routes, which are no longer supported. "
        + "Drop the flag and use --model auto instead.",
      );
    }
    if (!supportsAnthropicApiKeyFlag(getHarness(harnessId).firerouter)) {
      throw new Error("--anthropic-api-key is not supported by this harness.");
    }
  }
  if (ctx.openaiKeyFromFlag) {
    const validClaudeOn = harnessId === HARNESS.CLAUDE && isOn;
    if (!validClaudeOn && (!isOn || !firerouterRequested)) {
      throw new Error(
        harnessId === HARNESS.CLAUDE
          ? "--openai-api-key applies only to `nexus claude on`."
          : "--openai-api-key was for FireRouter routes, which are no longer supported. "
            + "Drop the flag and use --model auto instead.",
      );
    }
    if (!supportsOpenaiApiKeyFlag(getHarness(harnessId).firerouter)) {
      throw new Error("--openai-api-key is not supported by this harness.");
    }
  }
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
function persistAnthropicKeyFromFlag(ctx, home, harnessId) {
  if (!ctx.anthropicKeyFromFlag || !ctx.anthropicKey?.trim()) {
    return;
  }
  if (!isAnthropicShapedKey(ctx.anthropicKey)) {
    throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
  }
  return persistGlobalAnthropicApiKey(home, ctx.anthropicKey);
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
function persistOpenaiKeyFromFlag(ctx, home, harnessId) {
  if (!ctx.openaiKeyFromFlag || !ctx.openaiKey?.trim()) {
    return;
  }
  if (!isOpenAIShapedKey(ctx.openaiKey)) {
    throw new Error("--openai-api-key must be an OpenAI API key (sk-..., not sk-ant-...).");
  }
  return persistGlobalOpenaiApiKey(home, ctx.openaiKey);
}

export async function finalizeClaudeOnOutcome(
  outcome,
  {
    persistFireworksKey,
    persistAnthropicKey,
    persistOpenaiKey,
  } = {},
) {
  if (outcome?.cancelled) {
    process.exitCode = 1;
    return false;
  }
  await persistFireworksKey?.();
  await persistAnthropicKey?.();
  await persistOpenaiKey?.();
  return true;
}

/**
 * @param {{ harnessId: string, verb: string, noun?: string }} route
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runHarnessCommand(route, ctx) {
  const adapter = getHarness(route.harnessId);
  const onCtx = route.verb === "on" && !route.noun && adapter.resolveOnContext
    ? await adapter.resolveOnContext(ctx)
    : ctx;
  try {
    validateHarnessOptions(route, onCtx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.includes("Run: nexus")
        ? message
        : `${message} Run: nexus ${route.harnessId} help`,
    );
  }
  const home = ctx.home || process.env.HOME || "";
  let deferredClaudeApiKey = "";
  if (route.verb === "on" && home) {
    const azureMode = ctx.azure === true || ctx.provider === "azure";
    if (!azureMode && ctx.apiKeyFromFlag && ctx.apiKey?.trim()) {
      assertNoFireworksEnvForStorage();
      // Validate `--api-key` the same way `login` does — shape check then strict
      // verify — BEFORE persisting or enabling anything, so a typo or dead key
      // fails fast with a clear message instead of being baked into a harness
      // config and surfacing as a 401 in-tool later. Throws on failure.
      await assertFireworksKeyUsable(ctx.apiKey.trim());
      // Through the keychain path so baked-key sync runs in exactly one
      // place (inside persistApiKeyToKeychain). Adapters that persist the
      // flag again (claude direct, cursor) hit the idempotent no-op path —
      // no duplicate stores, no duplicate notes.
      if (route.harnessId === HARNESS.CLAUDE) {
        deferredClaudeApiKey = ctx.apiKey;
      } else {
        await persistApiKeyFromFlag(home, ctx.apiKey);
      }
    } else if (!azureMode && process.env.FIREWORKS_API_KEY?.trim()) {
      const envKey = assertFireworksKeyShape(process.env.FIREWORKS_API_KEY);
      if (
        FILE_CONFIG_HARNESS_SET.has(route.harnessId)
        && await canPersistApiKeyToKeychain(home)
        && !shouldSkipEnvKeyAutoPersist()
      ) {
        await persistApiKeyToKeychain(home, envKey);
      }
    }
    if (route.harnessId !== HARNESS.CLAUDE) {
      await persistAnthropicKeyFromFlag(ctx, home, route.harnessId);
      await persistOpenaiKeyFromFlag(ctx, home, route.harnessId);
    }
  }

  const outcome = await dispatchHarnessCommand(adapter, route, onCtx);
  if (
    route.verb === "on"
    && route.harnessId === HARNESS.CLAUDE
    && home
  ) {
    await finalizeClaudeOnOutcome(outcome, {
      persistFireworksKey: deferredClaudeApiKey
        ? () => persistApiKeyFromFlag(home, deferredClaudeApiKey)
        : undefined,
      persistAnthropicKey: () => persistAnthropicKeyFromFlag(ctx, home, route.harnessId),
      persistOpenaiKey: () => persistOpenaiKeyFromFlag(ctx, home, route.harnessId),
    });
  }
}
