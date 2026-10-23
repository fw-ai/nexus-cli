import { FIREWORKS_GATEWAY_URL } from "../fireworks/models.mjs";
import { verifyFireworksApiKey } from "./verify-api-key.mjs";

/**
 * Provider Keys for Nexus Auto: one active Anthropic or OpenAI
 * credential per Fireworks account, connected by an admin (or the user
 * themselves when they have access) in Model Providers / Provider Keys.
 * Harness-agnostic: the gateway applies the bound key to any `auto` turn
 * under the account, so developers only need their Fireworks key.
 *
 * This module only reads binding state for display. Upload and bind stay
 * admin surfaces (dashboard and firectl); the CLI never sends a provider
 * key to the control plane.
 */

export const PROVIDER_KEYS_SETTINGS_URL = "https://app.fireworks.ai/settings/provider-keys";

const PROVIDER_KEYS_FETCH_TIMEOUT_MS = 5_000;

const PROVIDER_TYPES = {
  anthropic: ["anthropic", "provider_type_anthropic", "1"],
  openai: ["openai", "provider_type_openai", "2"],
};

const BINDING_STATES = {
  connected: "connected",
  connecting: "connecting",
  disconnecting: "disconnecting",
  disconnected: "not-connected",
  not_connected: "not-connected",
  unspecified: "not-connected",
};

/**
 * @typedef {Object} ProviderKeyBindingStatus
 * @property {"connected"|"connecting"|"disconnecting"|"not-connected"} state
 * @property {string} keyHint Masked preview from the server; "" when none.
 */

/**
 * @typedef {Object} ProviderKeysStatus
 * @property {"ok"|"no-key"|"rejected"|"not-enabled"|"unavailable"} outcome
 * @property {string} accountId
 * @property {Record<"anthropic"|"openai", ProviderKeyBindingStatus>} providers
 * @property {string} reason
 */

const emptyProviders = () => ({
  anthropic: { state: "not-connected", keyHint: "" },
  openai: { state: "not-connected", keyHint: "" },
});

function normalizeProviderType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  for (const [provider, aliases] of Object.entries(PROVIDER_TYPES)) {
    if (aliases.includes(normalized)) {
      return provider;
    }
  }
  return null;
}

/**
 * A hint is display-only: keep it only when the server already masked it.
 * An unmasked value (misconfigured gateway, future server shape) is
 * re-masked client-side so a full provider key never reaches the terminal
 * or `--json` output.
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeKeyHint(raw) {
  const hint = String(raw ?? "").trim();
  if (!hint) {
    return hint;
  }
  // Trust a server hint only when it is plausibly a masked preview: short,
  // with a mask character and at most a 4-char tail after the last one. A
  // full key with a stray mask character in it fails this and is re-masked.
  const lastMask = Math.max(hint.lastIndexOf("•"), hint.lastIndexOf("*"));
  if (lastMask >= 0 && hint.length <= 32 && hint.length - lastMask - 1 <= 4) {
    return hint;
  }
  if (hint.length <= 8) {
    return "••••";
  }
  const prefix = hint.startsWith("sk-ant-")
    ? "sk-ant-"
    : hint.startsWith("sk-proj-")
      ? "sk-proj-"
      : hint.slice(0, 3);
  return `${prefix}••••${hint.slice(-4)}`;
}

function normalizeBindingState(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^state_/, "")
    .replace(/[\s-]+/g, "_");
  return BINDING_STATES[normalized] ?? "not-connected";
}

/**
 * Parse a ListProviderKeyBindings payload into per-provider display state.
 * Providers with no binding read as not connected.
 * @param {unknown} payload
 * @returns {Record<"anthropic"|"openai", ProviderKeyBindingStatus>}
 */
export function parseProviderKeyBindings(payload) {
  const providers = emptyProviders();
  const bindings = payload?.providerKeyBindings ?? payload?.provider_key_bindings ?? [];
  if (!Array.isArray(bindings)) {
    return providers;
  }
  for (const binding of bindings) {
    const provider = normalizeProviderType(binding?.providerType ?? binding?.provider_type);
    if (!provider) {
      continue;
    }
    providers[provider] = {
      state: normalizeBindingState(binding?.state),
      keyHint: sanitizeKeyHint(binding?.keyHint ?? binding?.key_hint),
    };
  }
  return providers;
}

async function fetchWithTimeout(fetchImpl, url, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the account's Provider Key bindings with the user's Fireworks key.
 * Never throws: every failure maps to an outcome the caller can print in
 * one line, so `nexus auto` stays usable offline and signed out.
 * @param {{ apiKey: string, gatewayUrl?: string, fetchImpl?: typeof fetch, verify?: typeof verifyFireworksApiKey, timeoutMs?: number }} args
 * @returns {Promise<ProviderKeysStatus>}
 */
export async function getProviderKeysStatus({
  apiKey,
  gatewayUrl = "",
  fetchImpl = fetch,
  verify = verifyFireworksApiKey,
  timeoutMs = PROVIDER_KEYS_FETCH_TIMEOUT_MS,
}) {
  const providers = emptyProviders();
  const key = apiKey?.trim() ?? "";
  if (!key) {
    return { outcome: "no-key", accountId: "", providers, reason: "" };
  }

  let verified;
  try {
    verified = await verify(key, { gatewayUrl, timeoutMs });
  } catch (error) {
    return { outcome: "unavailable", accountId: "", providers, reason: error instanceof Error ? error.message : "network error" };
  }
  if (!verified?.ok) {
    return {
      outcome: verified?.reason === "rejected" ? "rejected" : "unavailable",
      accountId: "",
      providers,
      reason: verified?.reason ?? "",
    };
  }
  const accountId = String(verified.accountId ?? "").trim().replace(/^accounts\//, "");
  if (!accountId) {
    return { outcome: "unavailable", accountId: "", providers, reason: "no account id" };
  }

  const base = gatewayUrl || process.env.NEXUS_GATEWAY_URL?.trim() || FIREWORKS_GATEWAY_URL;
  let response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `${base}/v1/accounts/${encodeURIComponent(accountId)}/providerKeyBindings`,
      key,
      timeoutMs,
    );
  } catch (error) {
    return {
      outcome: "unavailable",
      accountId,
      providers,
      reason: error instanceof Error ? error.message : "network error",
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = String(payload?.message ?? "");
    if (response.status === 400 && /provider keys are not enabled/i.test(message)) {
      return { outcome: "not-enabled", accountId, providers, reason: message };
    }
    return {
      outcome: "unavailable",
      accountId,
      providers,
      reason: message || `HTTP ${response.status}`,
    };
  }
  return { outcome: "ok", accountId, providers: parseProviderKeyBindings(payload), reason: "" };
}

/**
 * One-line display state for a single provider under an outcome.
 * @param {ProviderKeysStatus} status
 * @param {"anthropic"|"openai"} provider
 */
export function providerKeyStatusLine(status, provider) {
  switch (status?.outcome) {
    case "ok": {
      const binding = status.providers[provider];
      const hint = binding.keyHint ? ` (${binding.keyHint})` : "";
      switch (binding.state) {
        case "connected":
          return `Connected${hint}, covers every harness`;
        case "connecting":
          return `Connecting${hint}`;
        case "disconnecting":
          return `Disconnecting${hint}`;
        default:
          return "Not connected";
      }
    }
    case "not-enabled":
      return "Not enabled on this account";
    case "no-key":
      return "Sign in to see status";
    case "rejected":
      return "Key rejected: sign in again";
    default:
      return "Couldn't check just now";
  }
}
