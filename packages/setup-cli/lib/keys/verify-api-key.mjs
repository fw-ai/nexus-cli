import process from "node:process";
import { FIREWORKS_GATEWAY_URL } from "../fireworks/models.mjs";
import { fireworksGatewayFetchSignal } from "../fireworks/gateway-fetch.mjs";

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} ok
 * @property {"rejected"|"network"|"http"|""} reason  Why verification failed ("" when ok).
 * @property {string} email      Developer email from x-fireworks-developer-email (may be "").
 * @property {string} accountId  Account id from x-fireworks-account-id (may be "").
 * @property {number} status     HTTP status (0 on network failure).
 * @property {string} detail     Underlying error message for network failures.
 */

/**
 * Validate an API key against the gateway's lightweight identity endpoint.
 * GET /verifyApiKey returns 200 with the caller's account id and developer
 * email in response headers (empty body), 401/403 for a bad key.
 *
 * Never throws — callers map the result to one-line recovery copy.
 *
 * @param {string} apiKey
 * @param {{ gatewayUrl?: string }} [options]
 * @returns {Promise<VerifyResult>}
 */
export async function verifyFireworksApiKey(apiKey, { gatewayUrl = "" } = {}) {
  const base = gatewayUrl
    || process.env.NEXUS_GATEWAY_URL?.trim()
    || FIREWORKS_GATEWAY_URL;

  let response;
  try {
    response = await fetch(`${base}/verifyApiKey`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: fireworksGatewayFetchSignal(),
    });
  } catch (error) {
    const cause = error?.cause;
    const causeDetail = [
      cause?.code,
      cause?.message,
    ].filter(Boolean).join(": ");
    return {
      ok: false,
      reason: "network",
      email: "",
      accountId: "",
      status: 0,
      detail: causeDetail || error?.message || "network request failed",
    };
  }

  const email = response.headers.get("x-fireworks-developer-email") ?? "";
  const accountId = response.headers.get("x-fireworks-account-id") ?? "";

  if (response.ok) {
    return { ok: true, reason: "", email, accountId, status: response.status, detail: "" };
  }
  return {
    ok: false,
    reason: response.status === 401 || response.status === 403 ? "rejected" : "http",
    email: "",
    accountId: "",
    status: response.status,
    detail: "",
  };
}

/**
 * The identity to show in "Signed in as {…}." — prefer the developer email,
 * fall back to the account id, else "" (caller prints a non-identifying but
 * honest confirmation instead of inventing a name).
 * @param {VerifyResult} result
 */
export function identityLabel(result) {
  return result.email || result.accountId || "";
}
