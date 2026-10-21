import {
  defaultMainModel,
  fullFireworksResourceId,
  normalizeModelId,
  shortFireworksModelRef,
} from "../fireworks/model-id.mjs";
import { ALL_REASONING_EFFORTS } from "../fireworks/reasoning.mjs";
import { prettyModelName } from "../fireworks/models.mjs";
import { resolveFireworksCatalog } from "../fireworks/model-specs.mjs";

/**
 * Model selection shared by the two GitHub Copilot harnesses.
 *
 * `copilot-app` (desktop, ~/.copilot/data.db) and `copilot-cli`
 * (~/.copilot/providers.json) are separate harnesses because the products
 * share no config format. What they *do* share is which Fireworks models to
 * offer and what each one can do, so that lives here rather than being
 * duplicated or cross-imported between the two.
 */

export const COPILOT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

/**
 * Reasoning-effort levels published for every registered model.
 *
 * This is the shared ladder vocabulary ({@link ALL_REASONING_EFFORTS}), not a
 * per-model ladder: all four levels were probed against the gateway per model
 * and every one returns HTTP 200 on every model Nexus registers. `max`
 * matters — it is each model's strongest setting, so omitting it would hide a
 * level the gateway accepts. For a per-model ladder (e.g. to hide `max` where
 * it is unsupported), use `reasoningEffortNamesFor` from
 * `../fireworks/reasoning.mjs` — but only after probing, since narrowing this
 * list removes a level the gateway would have accepted.
 *
 * Deliberately absent: `none` (the GLM models reject it outright — "GLM-5.3 is
 * a thinking-only model"), `xhigh` (accepted, but sits between `high` and
 * `max` with no distinct behaviour), and `minimal` (absent from Fireworks'
 * `reasoning_effort` enum entirely).
 */
export const COPILOT_REASONING_EFFORTS = ALL_REASONING_EFFORTS;

/**
 * Default model id both harnesses register.
 * @returns {string}
 */
export function defaultCopilotModelId() {
  return fullFireworksResourceId(defaultMainModel());
}

/**
 * Resolve a user-supplied `--model` for `on`: normalize Fireworks refs,
 * falling back to the default.
 * @param {string | undefined} modelId
 * @returns {string}
 */
export function resolveCopilotModelId(modelId) {
  return normalizeModelId(modelId || defaultCopilotModelId());
}

/**
 * Describe each model once, from the serverless catalog, for whichever
 * harness is writing. Each consumer takes the fields its format supports:
 * the desktop schema has no vision column, the CLI has no per-level effort
 * list.
 *
 * @param {string[]} modelIds  short Fireworks refs
 * @returns {Array<{ id: string, displayName: string, maxPromptTokens: number|null, maxOutputTokens: number|null, vision: boolean }>}
 */
export function describeCopilotModels(modelIds) {
  return modelIds.map((id) => {
    const { limits } = resolveFireworksCatalog(id);
    return {
      id,
      displayName: prettyModelName(id) || id,
      maxPromptTokens: limits?.contextWindow ?? null,
      maxOutputTokens: limits?.maxTokens ?? null,
      vision: Boolean(limits?.vision),
    };
  });
}

/** Dedupe + normalize a model list to short refs, dropping empties. */
export function copilotModelIds(ids) {
  return [...new Set(ids.map((id) => shortFireworksModelRef(id)).filter(Boolean))];
}

/**
 * Model rows for the desktop app's provider_models table: the shared
 * description plus the wire id and reasoning-effort menu the app schema
 * requires (without them the picker hides the context readout and the
 * effort control).
 *
 * @param {string[]} modelIds  short Fireworks refs
 */
export function describeCopilotAppModels(modelIds) {
  return describeCopilotModels(modelIds).map((model) => ({
    ...model,
    wireModel: model.id,
    supportedReasoningEfforts: JSON.stringify(COPILOT_REASONING_EFFORTS),
  }));
}
