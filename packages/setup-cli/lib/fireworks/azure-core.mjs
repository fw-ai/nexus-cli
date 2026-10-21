import process from "node:process";
import { isFireworksShapedKey } from "../keys/key-type.mjs";
import {
  DEFAULT_FIREWORKS_MODEL_LIMITS,
  lookupFireworksModelLimits,
  lookupModelSpec,
} from "./model-specs.mjs";

// Fireworks AI models are available as first-party models inside Microsoft
// Foundry (formerly Azure AI Foundry). Foundry exposes an OpenAI-compatible
// inference API, so harnesses that speak OpenAI (OpenCode) can route through a
// Foundry project endpoint using an Azure API key instead of the Fireworks
// gateway. See: https://docs.fireworks.ai/ecosystem/integrations/azure-foundry

// Default Foundry deployment name for the GLM model published by Fireworks.
// Foundry model ids are the catalog Model ID chosen at deploy time (e.g.
// `FW-GLM-5.2`, `FW-MiniMax-M2.5`). Override with --model to match your
// deployment name. Catalog: https://ai.azure.com/catalog/models?source=fireworks
export const DEFAULT_AZURE_MODEL = "FW-GLM-5.2";

/**
 * Foundry catalog Model IDs with a matching Fireworks serverless spec for
 * context/pricing metadata. Omit Foundry-only models and serverless-only slugs.
 * @see https://learn.microsoft.com/en-us/azure/foundry/how-to/fireworks/enable-fireworks-models#available-catalog-models
 */
export const AZURE_FOUNDRY_SUPPORTED_MODELS = {
  "FW-GLM-5.2": "glm-5p2",
  "FW-GLM-5.1": "glm-5p1",
  "FW-DeepSeek-V4-Flash": "deepseek-v4-flash",
  "FW-DeepSeek-V4-Pro": "deepseek-v4-pro",
  "FW-MiniMax-M2.5": "minimax-m2p5",
  "FW-Kimi-K2.5": "kimi-k2p5",
  "FW-Kimi-K2.6": "kimi-k2p6",
  "FW-Kimi-K2.7-Code": "kimi-k2p7-code",
  "FW-GPT-OSS-120B": "gpt-oss-120b",
};

/**
 * Map a Foundry catalog Model ID to a Fireworks serverless spec slug when known.
 * @param {string} deploymentName
 * @returns {string | null}
 */
export function azureFoundryDeploymentToSlug(deploymentName) {
  if (!deploymentName || typeof deploymentName !== "string") {
    return null;
  }
  return AZURE_FOUNDRY_SUPPORTED_MODELS[deploymentName.trim()] ?? null;
}

/**
 * Resolve a Foundry deployment to a Fireworks model spec slug when known.
 * @param {string} deploymentName
 * @returns {string | null}
 */
export function resolveAzureFoundryModelSlug(deploymentName) {
  const slug = azureFoundryDeploymentToSlug(deploymentName);
  if (!slug || !lookupModelSpec(slug)) {
    return null;
  }
  return slug;
}

/** Context/modality limits for a Foundry deployment from the shared Fireworks specs. */
export function lookupAzureFoundryModelLimits(deploymentName) {
  const slug = resolveAzureFoundryModelSlug(deploymentName);
  if (!slug) {
    return DEFAULT_FIREWORKS_MODEL_LIMITS;
  }
  return lookupFireworksModelLimits(slug);
}

// npm adapter OpenCode loads for any OpenAI-compatible provider.
export const AZURE_OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

// Display name shown by the harness for the Azure-backed provider.
export const AZURE_PROVIDER_LABEL = "Fireworks on Microsoft Foundry";

/**
 * Azure endpoint precedence, shared by every harness's `on --azure`: an explicit
 * `--base-url` wins, then the endpoint from `nexus configure`, then the
 * endpoint already stored from a previous `on --azure`.
 * @param {{ baseUrl?: string, baseUrlFromFlag?: boolean }} ctx
 * @param {{ baseUrl?: string }} configured
 * @param {string} storedBaseUrl
 * @returns {string}
 */
export function resolveAzureBaseUrl(ctx, configured, storedBaseUrl) {
  return ctx.baseUrlFromFlag ? ctx.baseUrl : (configured.baseUrl || storedBaseUrl);
}

// Environment variable / reference used when the Azure key is provided via the
// environment rather than written literally into a config file.
export const AZURE_API_KEY_ENV = "AZURE_API_KEY";
export const AZURE_API_KEY_ENV_REF = `{env:${AZURE_API_KEY_ENV}}`;

export const MISSING_AZURE_BASE_URL_MESSAGE =
  "No Azure endpoint found. Pass --base-url with your Microsoft Foundry project endpoint "
  + "(e.g. https://<resource>.services.ai.azure.com).";

export const MISSING_AZURE_API_KEY_MESSAGE =
  `No Azure API key found. Export ${AZURE_API_KEY_ENV} or pass --api-key with your Foundry key.`;

export const FIREWORKS_KEY_AS_AZURE_MESSAGE =
  "The Azure API key cannot be a Fireworks key (fw_...). "
  + "Use the endpoint key from Microsoft Foundry.";

/**
 * Does this stored value reference the AZURE_API_KEY env var rather than hold
 * a literal key? Harnesses store the reference in different shapes — OpenCode
 * and Codex use `{env:AZURE_API_KEY}`, Pi uses `$AZURE_API_KEY` (and the
 * `${AZURE_API_KEY}` form is also accepted). All three mean "no secret on
 * disk", which matters for file-permission decisions (env-ref configs must
 * NOT be chmod'd to 0600).
 * @param {string} key
 */
export function isAzureApiKeyEnvRef(key) {
  if (typeof key !== "string" || !key) {
    return false;
  }
  return key === AZURE_API_KEY_ENV_REF
    || key === `$${AZURE_API_KEY_ENV}`
    || key === `\${${AZURE_API_KEY_ENV}}`;
}

export function assertAzureApiKey(apiKey) {
  const effective = isAzureApiKeyEnvRef(apiKey)
    ? process.env[AZURE_API_KEY_ENV]?.trim() ?? ""
    : apiKey;
  if (isFireworksShapedKey(effective)) {
    throw new Error(FIREWORKS_KEY_AS_AZURE_MESSAGE);
  }
}

function validatedAzureKeyResult(apiKey, apiKeyFromFlag, reusedExistingKey) {
  assertAzureApiKey(apiKey);
  return { apiKey, apiKeyFromFlag, reusedExistingKey };
}

/**
 * Heuristic: does this URL look like a Microsoft Foundry / Azure AI endpoint?
 * @param {string} url
 */
export function isAzureBaseUrl(url) {
  return typeof url === "string" && /\.azure\.com(?::\d+)?(\/|$)/i.test(url.trim());
}

/**
 * Normalize a Foundry endpoint to its OpenAI-compatible base URL.
 *
 * Foundry's OpenAI-compatible API (`/chat/completions`, which the
 * `@ai-sdk/openai-compatible` adapter appends to the base) always lives at the
 * **resource root** — `https://<resource>.services.ai.azure.com/openai/v1` —
 * never under the project path. So for any Azure host we reduce the URL to its
 * origin and append `/openai/v1`, which means all of these resolve correctly:
 *
 *   - bare resource root            (`.../`)
 *   - the portal "project endpoint" (`.../api/projects/<name>`)
 *   - the Foundry Models route      (`.../models`)
 *   - an already-correct base       (`.../openai/v1`)
 *
 * For non-Azure hosts (custom gateways / APIM proxies) we stay conservative:
 * preserve the supplied path and only ensure an `/openai/v1` suffix.
 *
 * @param {string} endpoint
 * @returns {string}
 */
export function normalizeAzureBaseUrl(endpoint) {
  const raw = String(endpoint ?? "").trim();
  if (!raw) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }

  if (parsed && isAzureBaseUrl(raw)) {
    return `${parsed.origin}/openai/v1`;
  }

  let url = raw.replace(/\/+$/, "");
  if (/\/openai\/v\d+$/i.test(url)) {
    return url;
  }
  url = url.replace(/\/models$/i, "").replace(/\/openai$/i, "");
  return `${url}/openai/v1`;
}

/**
 * Resolve the Azure API key and how it should be stored for `<harness> on`.
 *
 * Resolution order:
 *   1. explicit `--api-key` (stored literally)
 *   2. existing stored key on a previous `on` (reused as-is)
 *   3. the key configured via `nexus configure` (stored literally)
 *   4. `AZURE_API_KEY` environment variable (stored as the {env:...} reference)
 *
 * @param {{
 *   apiKey?: string,
 *   apiKeyFromFlag?: boolean,
 *   configuredApiKey?: string,
 *   getExistingKey?: () => Promise<string>,
 * }} args
 * @returns {Promise<{ apiKey: string, apiKeyFromFlag: boolean, reusedExistingKey: boolean }>}
 */
export async function resolveAzureOnApiKey({
  apiKey = "",
  apiKeyFromFlag = false,
  configuredApiKey = "",
  getExistingKey,
} = {}) {
  if (apiKeyFromFlag && apiKey.trim()) {
    return validatedAzureKeyResult(apiKey.trim(), true, false);
  }

  if (getExistingKey) {
    const existing = (await getExistingKey()) ?? "";
    if (existing) {
      return validatedAzureKeyResult(
        existing,
        !isAzureApiKeyEnvRef(existing),
        true,
      );
    }
  }

  if (configuredApiKey && !isAzureApiKeyEnvRef(configuredApiKey)) {
    return validatedAzureKeyResult(configuredApiKey.trim(), true, false);
  }

  if (process.env[AZURE_API_KEY_ENV]?.trim()) {
    return validatedAzureKeyResult(AZURE_API_KEY_ENV_REF, false, false);
  }

  throw new Error(MISSING_AZURE_API_KEY_MESSAGE);
}

/**
 * Resolve the {env:AZURE_API_KEY} reference to the real environment value.
 * @param {string} storedKey
 */
export function effectiveAzureApiKey(storedKey) {
  if (!storedKey) {
    return "";
  }
  if (storedKey === AZURE_API_KEY_ENV_REF) {
    return process.env[AZURE_API_KEY_ENV]?.trim() ?? "";
  }
  return storedKey;
}
