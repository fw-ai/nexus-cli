import {
  isFirerouterModel,
  isFirerouterModelPattern,
  firerouterNamesAnthropicModel,
  firerouterRequiresAnthropicKey,
  firerouterRequiresOpenaiKey,
} from "../fireworks/model-id.mjs";
import {
  firerouterByokHeaders,
  resolveAnthropicKey,
  resolveFirerouterByokKeys,
  resolveOpenaiKey,
} from "./core.mjs";

export const FIREROUTER_WORKSPACE_BYOK_REQUIRED_MESSAGE =
  "Ask the Fireworks team to enable FireRouter for your account.";

export const FIREROUTER_BYOK_REQUIRED_MESSAGE =
  "FireRouter needs your Anthropic API key. "
  + "Set ANTHROPIC_API_KEY, pass --anthropic-api-key <sk-ant-...>, "
  + "or ask the Fireworks team to enable FireRouter for your account."

/**
 * Resolve the error message for a missing FireRouter credential requirement.
 * @param {{ byok?: "value"|"none" }|null|undefined} firerouter
 * @returns {string}
 */
export function firerouterCredentialsRequiredMessage(firerouter) {
  if (firerouter?.byok === "none") {
    return FIREROUTER_WORKSPACE_BYOK_REQUIRED_MESSAGE;
  }
  return FIREROUTER_BYOK_REQUIRED_MESSAGE;
}

/**
 * Resolve or prompt for Anthropic credentials when the user explicitly selects
 * FireRouter (`--model firerouter` or a Claude slot). Never throws for
 * harnesses that cannot forward a key (`byok: "none"`): the key is resolved
 * best-effort (flag/global/env/settings, no prompt) and the `on` proceeds
 * without BYOK headers, so FireRouter keeps routing the Fireworks mix instead
 * of failing the connect.
 *
 * @param {{
 *   firerouter?: { byok?: "value"|"none" }|null,
 *   ctx?: { anthropicKey?: string, anthropicKeyFromFlag?: boolean, home?: string },
 *   settingsEnv?: Record<string, string>,
 *   allowPromptSkip?: boolean,
 * }} input
 */
export async function resolveExplicitFirerouterCredential({
  firerouter = null,
  ctx = {},
  settingsEnv = {},
  allowPromptSkip = true,
} = {}) {
  if (!firerouter) {
    return { anthropicKey: "" };
  }
  if (firerouter.byok === "none") {
    // No forwarding path on this harness: resolve best-effort (flag, stored
    // global, env, settings) with no prompt, then proceed without BYOK headers.
    return {
      anthropicKey: await resolveAnthropicKey({
        apiKey: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
        settingsEnv,
        home: ctx.home,
      }),
    };
  }
  return resolveFirerouterByokKeys({
    anthropicFlag: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
    settingsEnv,
    home: ctx.home,
    explicit: true,
    allowPromptSkip,
  });
}

/**
 * Whether a harness accepts `--anthropic-api-key` on `on`.
 * Value harnesses embed the key in config headers. Claude Code refuses it:
 * its own sign-in pays for Claude turns.
 * @param {{ byok?: "value"|"none" }|null|undefined} firerouter
 * @returns {boolean}
 */
export function supportsAnthropicApiKeyFlag(firerouter) {
  return firerouter?.byok === "value";
}

/**
 * Whether a harness accepts `--openai-api-key` on `on`. Value harnesses embed
 * the key in config headers, and Claude Code carries it in
 * ANTHROPIC_CUSTOM_HEADERS next to the Fireworks key.
 * @param {{ byok?: "value"|"none", customHeaderOpenaiKey?: boolean }|null|undefined} firerouter
 * @returns {boolean}
 */
export function supportsOpenaiApiKeyFlag(firerouter) {
  return firerouter?.byok === "value"
    || firerouter?.customHeaderOpenaiKey === true;
}

/**
 * @typedef {Object} FirerouterPlan
 * @property {string}  mainModel     Model id to write to the harness's main slot
 *                                   ("" = keep the harness's normal Fireworks default).
 * @property {boolean} isFirerouter  Whether `mainModel` routes through FireRouter.
 * @property {boolean} requiresAnthropicKey
 *   Whether the selection uses an Anthropic credential (bare firerouter or a
 *   Claude/Opus model in the path). Pure-Fireworks selections need none.
 * @property {boolean} requiresOpenaiKey
 *   Whether the selection routes to an OpenAI model in the path
 *   (firerouter/gpt-...). Bare firerouter needs none; a configured OpenAI key
 *   still rides along opportunistically.
 * @property {boolean} namesAnthropicModel
 *   Whether the path names a Claude/Opus model. Harnesses that cannot forward
 *   an Anthropic key refuse only these; bare firerouter falls back to a GPT model
 *   or open models without one.
 */

/**
 * Resolve the routing plan from the requested model. FireRouter is a regular
 * gateway model now (generally available — no account entitlement lookup):
 * `--model firerouter` selects it; anything else keeps the harness's normal
 * default. Nexus never auto-selects firerouter.
 *
 * @param {{ main?: string }} ctx
 * @returns {FirerouterPlan}
 */
export function resolveFirerouterPlan(ctx) {
  const requested = ctx.main?.trim() ?? "";
  if (!requested) {
    return {
      mainModel: "",
      isFirerouter: false,
      requiresAnthropicKey: false,
      requiresOpenaiKey: false,
      namesAnthropicModel: false,
    };
  }
  return {
    mainModel: requested,
    isFirerouter: isFirerouterModelPattern(requested),
    requiresAnthropicKey: firerouterRequiresAnthropicKey(requested),
    requiresOpenaiKey: firerouterRequiresOpenaiKey(requested),
    namesAnthropicModel: firerouterNamesAnthropicModel(requested),
  };
}

/**
 * Value-based BYOK headers for custom-header harnesses (Claude/OpenCode/Pi/
 * VS Code). Resolves at most one key per provider family (Anthropic, OpenAI)
 * from flag/env/settings — prompting once for an Anthropic key when the
 * selection needs one and none is available — then maps present keys to the
 * wire headers. A key rides along only where the selection can route to its
 * provider: Anthropic on Anthropic-requiring selections (`firerouter`,
 * `firerouter/opus`), OpenAI on bare `firerouter` or GPT-member selections
 * (`firerouter/gpt-...`). A missing key stays absent instead of failing the
 * `on`. Returns `{}` when the plan isn't routing through FireRouter.
 * `settingsEnv` surfaces keys a harness already stores.
 *
 * @param {{
 *   plan: FirerouterPlan,
 *   ctx: { anthropicKey?: string, anthropicKeyFromFlag?: boolean, openaiKey?: string, openaiKeyFromFlag?: boolean, home?: string },
 *   settingsEnv?: Record<string, string>,
 *   preResolvedAnthropicKey?: string,
 * }} args
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveFirerouterByokHeaders({
  plan,
  catalogFirerouter = false,
  ctx,
  settingsEnv = {},
  preResolvedAnthropicKey,
}) {
  if (!plan.isFirerouter && !catalogFirerouter) {
    return {};
  }
  /** @type {Record<string, string>} */
  const headers = {};
  // Anthropic BYOK is only attached when the selection routes to an Anthropic
  // model. Pure-Fireworks firerouter paths (e.g. firerouter/kimi-k3 on VS Code,
  // where catalogFirerouter is true) must not prompt for or attach a key.
  if (plan.requiresAnthropicKey) {
    const anthropicKey = preResolvedAnthropicKey !== undefined
      ? preResolvedAnthropicKey
      : (await resolveFirerouterByokKeys({
        anthropicFlag: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
        settingsEnv,
        home: ctx.home,
        explicit: true,
      })).anthropicKey;
    Object.assign(headers, firerouterByokHeaders({ anthropicKey }));
  }
  // OpenAI keys are never prompted for and never required: attach when
  // configured and routable (bare firerouter, whose mix can serve GPT
  // primaries, or a GPT member in the path). Pinned non-GPT compounds stay
  // clean even with a key configured.
  if (plan.requiresOpenaiKey || isFirerouterModel(plan.mainModel)) {
    const openaiKey = await resolveOpenaiKey({
      apiKey: ctx.openaiKeyFromFlag ? ctx.openaiKey : "",
      settingsEnv,
      home: ctx.home,
    });
    Object.assign(headers, firerouterByokHeaders({ openaiKey }));
  }
  return headers;
}
