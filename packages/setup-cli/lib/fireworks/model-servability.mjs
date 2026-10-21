import { isAutoModelId } from "./model-specs.mjs";
import {
  isAnthropicModelId,
  isFirerouterRouteRef,
  shortFireworksModelRef,
} from "./model-id.mjs";
import { loadServerlessCatalog } from "./models.mjs";

// Custom (user-deployed) Fireworks models are served on the gateway but aren't
// listed in the public serverless catalog, so the servability check must allow
// them through.
const CUSTOM_DEPLOYMENT_REF_RE = /^accounts\/[^/]+\/deployments\/[^/]+(\[1m\])?$/i;

/**
 * Whether `--model` must resolve in the serverless catalog.
 * Gateway ids that are never catalog rows skip the check: rooted
 * `firerouter` routes, `auto` / `auto-*`, concrete Anthropic ids, and
 * private `accounts/…/deployments/…`. The Claude `claude-default` sentinel
 * is not one of those — only Claude Code understands it. Empty means the
 * harness default.
 * @param {string} modelId
 * @returns {boolean}
 */
export function isModelIdValidationApplicable(modelId) {
  if (!modelId) {
    return false;
  }
  const ref = shortFireworksModelRef(modelId);
  const servedOutsideCatalog = isFirerouterRouteRef(ref)
    || isAutoModelId(ref)
    || isAnthropicModelId(ref)
    || CUSTOM_DEPLOYMENT_REF_RE.test(ref);
  return !servedOutsideCatalog;
}

/**
 * Throw if any provided model id isn't a real Fireworks serverless model.
 *
 * Fetches the live serverless catalog once and checks every applicable id
 * against it. Validation is skipped (no throw) when:
 *   - no id needs validating (all empty / firerouter / custom deployment), or
 *   - the catalog fetch fails (offline) — we can't verify, so we don't block.
 *
 * @param {string[]} modelIds
 * @param {{ apiKey: string }} opts
 * @returns {Promise<void>}
 */
export async function assertRequestedModelsServable(modelIds, { apiKey } = {}) {
  const applicable = modelIds.filter(Boolean).filter(isModelIdValidationApplicable);
  if (applicable.length === 0) return;
  let catalog;
  try {
    ({ catalog } = await loadServerlessCatalog({ apiKey }));
  } catch {
    return; // offline / fetch failed — can't verify, don't block
  }
  if (!Array.isArray(catalog) || catalog.length === 0) return;
  const known = new Set(catalog.flatMap((entry) => [entry?.shortId, entry?.id].filter(Boolean)));
  for (const id of applicable) {
    // Match the shortened ref, not its last segment. A last-segment hit would
    // admit `fireworks/kimi-k3` or `accounts/acme/models/kimi-k3` whenever the
    // public slug is listed.
    const short = String(shortFireworksModelRef(id)).replace(/\[1m\]$/i, "");
    if (known.has(short)) {
      continue;
    }
    throw new Error(
      `Model "${shortFireworksModelRef(id)}" is not available on Fireworks. `
      + `Run \`nexus model list\` to see serverless models.`,
    );
  }
}

/** Single-id convenience wrapper around {@link assertRequestedModelsServable}. */
export function assertRequestedModelServable(modelId, opts) {
  return assertRequestedModelsServable([modelId], opts);
}
/**
 * Servability probe: catalog membership alone is not enough — the catalog
 * lists retired models (dated snapshots, superseded generations) with full
 * metadata and no flag, so the only retirement signal is a request: 404
 * "Model not found" at POST /inference/v1/messages. Anything else (2xx, 429,
 * other 4xx) means the model serves. 16-token probe; call from setup paths
 * only (never a hot path); NEXUS_TEST gates real calls.
 * @param {string} modelId
 * @param {string} apiKey
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<boolean>}
 */
export async function probeModelServable(modelId, apiKey, { timeoutMs = 8_000, fetchImpl = fetch } = {}) {
  if (process.env.NEXUS_TEST === "1") return true;
  try {
    const res = await fetchImpl("https://api.fireworks.ai/inference/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, max_tokens: 8, messages: [{ role: "user", content: "ok" }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status !== 404;
  } catch {
    return true; // network trouble is not a verdict; keep the model
  }
}

/**
 * Filter model ids to the servable ones, probing in parallel.
 * @param {string[]} modelIds
 * @param {string} apiKey
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string[]>}
 */
export async function servableModels(modelIds, apiKey, options = {}) {
  const verdicts = await Promise.allSettled(modelIds.map((id) => probeModelServable(id, apiKey, options)));
  return modelIds.filter((_, i) => verdicts[i].status !== "fulfilled" || verdicts[i].value);
}
