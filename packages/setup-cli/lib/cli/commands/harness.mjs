import process from "node:process";
import { dispatchHarnessCommand } from "../../harness/types.mjs";
import { getHarness } from "../../harness/registry.mjs";
import { readGlobalConfig } from "../../config/global-config.mjs";
import { AUTO_PROVIDER_KEYS } from "../../keys/auto-provider-keys.mjs";
import { PROVIDER_KEYS_DOCS_URL } from "../messages.mjs";
import { checkHarnessInstall } from "../../harness/detect.mjs";
import { HARNESS_PATH_FLAGS } from "../parse-args.mjs";
import { FILE_CONFIG_HARNESS_SET, HARNESS } from "../../harness/id.mjs";
import { assertNotFirerouterModelId } from "../../fireworks/model-id.mjs";
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

// What pays for a provider in the harness whose own sign-in covers it, so a
// key saved with `nexus auto` never goes there.
const OWN_SIGN_IN_HINT = Object.freeze({
  [HARNESS.CLAUDE]: "Claude Code's own login covers Claude turns: run `claude login`, or export "
    + "ANTHROPIC_API_KEY for Claude Code to use.",
  [HARNESS.CODEX]: "Codex's own sign-in covers GPT turns: run `codex login`, or sign Codex in with an "
    + "OpenAI key using `codex login --with-api-key`.",
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
  // `claude live --session` is still accepted so old invocations reach the retirement notice.
  const sessionAllowed = harnessId === HARNESS.CLAUDE && !noun
    && (verb === "usage" || verb === "live");
  if (ctx.session && !sessionAllowed) {
    throw new Error("--session applies only to `nexus claude usage`.");
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
    throw new Error("To clear a saved provider key, run `nexus auto --unset openai-api-key` (or `--unset anthropic-api-key`).");
  }
  if (ctx.anthropic || ctx.openai || ctx.storedOnly || ctx.withToken || ctx.revoke || ctx.paste || ctx.account) {
    throw new Error("This option belongs to a global login/logout/key command, not a harness command.");
  }

  // Provider keys for Nexus Auto are saved once with `nexus auto`, not per
  // harness command.
  for (const [fromFlag, flag, provider] of [
    [ctx.anthropicKeyFromFlag, "--anthropic-api-key", "anthropic"],
    [ctx.openaiKeyFromFlag, "--openai-api-key", "openai"],
  ]) {
    if (!fromFlag) {
      continue;
    }
    const { ownSignIn, reaches } = AUTO_PROVIDER_KEYS[provider];
    if (ownSignIn === harnessId) {
      throw new Error(`${flag} isn't a harness option. ${OWN_SIGN_IN_HINT[harnessId]}`);
    }
    if (!reaches(getHarness(harnessId))) {
      throw new Error(
        `${flag} isn't a harness option, and ${getHarness(harnessId).label ?? harnessId} can't carry provider keys. `
          + `Add a Provider Key on your Fireworks account instead: ${PROVIDER_KEYS_DOCS_URL}.`,
      );
    }
    throw new Error(
      `${flag} isn't a harness option. Save the key once with \`nexus auto ${flag} <key>\`, `
        + `then run \`nexus ${harnessId}\` again.`,
    );
  }
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
 * Refuse `on` for a harness that isn't installed on this machine, before any
 * key is persisted or config written. "Installed" is any sign of the tool:
 * its command, its app, its editor extension, or data only it writes (see
 * `harnessInstallSpecs`). Skipped when the harness is already in the global
 * config (a re-apply), when a path flag points the harness's own config
 * elsewhere (`--data-dir` only moves Nexus's backups, so it doesn't count),
 * and with `--skip-install-check`.
 * @param {import("../../harness/types.mjs").HarnessAdapter} adapter
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {string} home
 */
export async function assertHarnessInstalled(adapter, ctx, home) {
  if (!home || ctx.skipInstallCheck) {
    return;
  }
  if (Object.values(HARNESS_PATH_FLAGS).some((key) => ctx[key])) {
    return;
  }
  const { state, hint } = checkHarnessInstall(home, adapter.id);
  if (state !== "missing") {
    return;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (harnesses[adapter.id]?.enabled) {
    return;
  }
  throw new Error(
    `${adapter.label} isn't installed (looked for ${hint}). Install ${adapter.label}, `
    + `then run: nexus ${adapter.id}. If it is installed, pass --skip-install-check.`,
  );
}

/**
 * @param {{ harnessId: string, verb: string, noun?: string }} route
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runHarnessCommand(route, ctx) {
  const adapter = getHarness(route.harnessId);
  const home = ctx.home || process.env.HOME || "";
  // Before resolveOnContext, so a missing install is the first error rather
  // than a model or provider one, and Codex doesn't refresh its models first.
  if (route.verb === "on" && !route.noun) {
    await assertHarnessInstalled(adapter, ctx, home);
  }
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
    });
  }
}
