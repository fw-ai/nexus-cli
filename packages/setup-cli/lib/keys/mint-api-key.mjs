import os from "node:os";
import path from "node:path";
import process from "node:process";
import { rm } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { grpcWebCall, pbDecode, pbField, pbString, pbStringAt } from "../auth/grpc-web.mjs";
import { readJsonIfExists, writeJson } from "../io/json.mjs";

/**
 * Exchange a Cognito id_token for an fw_ API key, so browser sign-in
 * converges on the same credential the paste flow stores. Uses the control
 * plane's gRPC-web surface at gateway.fireworks.ai — the same endpoint and
 * bearer the web console uses to create keys; the REST facade is closed to
 * external callers by a gateway-secret gate.
 *
 * Three unary calls: ListAccounts (find the account), ListUsers (find the
 * caller's user resource by email), CreateApiKey (mint a key named
 * fireconnect-{hostname}, returned in plaintext exactly once).
 */
export const GATEWAY_GRPC_WEB_URL = process.env.NEXUS_GATEWAY_GRPC_WEB_URL?.trim()
  || "https://gateway.fireworks.ai/web/gateway.Gateway";

/**
 * Shown when the developer browser flow can't mint a key (SSO tenants land
 * here: their sign-in works but resolves to no account on the developer
 * pool). Points at the SSO path that DOES work for them.
 */
export const BROWSER_SSO_UNSUPPORTED_HINT =
  "(Teams that sign in with custom SSO: run nexus login --account <account-id> instead — option 3 in the login menu.)";

export const BROWSER_SIGNIN_NO_ACCOUNT_FAILURE =
  `Your sign-in worked, but no Fireworks account is associated with it. ${BROWSER_SSO_UNSUPPORTED_HINT}`;

/** display_name for keys this CLI mints; the hostname says which machine to revoke. */
export function mintedKeyName(hostname = os.hostname()) {
  const host = hostname.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-") || "cli";
  return `nexus-${host}`;
}

/**
 * @typedef {Object} MintResult
 * @property {boolean} ok
 * @property {string} key        The fw_ key ("" on failure).
 * @property {string} keyId      Unkey key id, for future revocation.
 * @property {string} userName   accounts/{account}/users/{user} the key belongs to.
 * @property {string} failure    One-line reason for the terminal ("" when ok).
 */

const failed = (failure) => ({ ok: false, key: "", keyId: "", userName: "", failure });

/**
 * List the Fireworks accounts an id_token principal can mint keys under. The
 * control plane resolves the principal to its accounts server-side; when more
 * than one comes back the caller must pick which one the key belongs to,
 * since minting under the wrong account silently puts the key where the user
 * didn't mean to (and the CLI would still report success for their identity).
 * @param {string} idToken
 * @param {{ baseUrl?: string }} [options]
 * @returns {Promise<{ ok: boolean, accountNames: string[], failure: string }>}
 */
export async function listAccountsForIdToken(idToken, { baseUrl = GATEWAY_GRPC_WEB_URL } = {}) {
  let accounts;
  try {
    accounts = await grpcWebCall(baseUrl, "ListAccounts", Buffer.alloc(0), idToken);
  } catch (error) {
    return { ok: false, accountNames: [], failure: `Couldn't reach the Fireworks control plane (${error?.message ?? "network error"}).` };
  }
  if (accounts.status !== 0 || !accounts.message) {
    return { ok: false, accountNames: [], failure: rpcFailureLine("looking up your account", accounts) };
  }
  return { ok: true, accountNames: allResourceNames(accounts.message), failure: "" };
}

/**
 * Mint a named fw_ key under a specific account: ListUsers (find the caller's
 * user resource by email), then CreateApiKey (the plaintext key is returned
 * exactly once). Split from the ListAccounts lookup so an interactive caller
 * can resolve the account and prompt between the two calls.
 * @param {string} idToken
 * @param {string} accountName  e.g. "accounts/acme"
 * @param {{ email?: string, baseUrl?: string, keyName?: string }} [options]
 * @returns {Promise<MintResult>}
 */
export async function mintApiKeyForAccount(idToken, accountName, {
  email = "",
  baseUrl = GATEWAY_GRPC_WEB_URL,
  keyName = mintedKeyName(),
} = {}) {
  const usersRequest = Buffer.concat([
    pbString(1, accountName),
    ...(email ? [pbString(4, `email="${email}"`)] : []),
  ]);
  let users;
  try {
    users = await grpcWebCall(baseUrl, "ListUsers", usersRequest, idToken);
  } catch (error) {
    return failed(`Couldn't reach the Fireworks control plane (${error?.message ?? "network error"}).`);
  }
  if (users.status !== 0 || !users.message) {
    return failed(rpcFailureLine("looking up your user", users));
  }
  const userNames = allResourceNames(users.message);
  if (userNames.length === 0) {
    return failed(`Couldn't find your user in ${accountName}.`);
  }
  if (!email && userNames.length > 1) {
    // Without an email claim (some SSO/federated sign-ins omit it) the
    // ListUsers filter is skipped and every user in the account comes back.
    // Picking the first would mint a key under whoever the server lists
    // first — possibly not the caller — so refuse instead.
    return failed(
      `Your sign-in didn't say which of ${accountName}'s users you are, so no key was created — use nexus login --paste instead.`,
    );
  }
  const userName = userNames[0];

  // CreateApiKeyRequest{ parent = user, api_key.display_name = keyName }
  const createRequest = Buffer.concat([
    pbString(1, userName),
    pbField(2, pbString(2, keyName)),
  ]);
  let created;
  try {
    created = await grpcWebCall(baseUrl, "CreateApiKey", createRequest, idToken);
  } catch (error) {
    return failed(`Couldn't reach the Fireworks control plane (${error?.message ?? "network error"}).`);
  }
  if (created.status !== 0 || !created.message) {
    return failed(rpcFailureLine("creating an API key", created));
  }
  const fields = pbDecode(created.message);
  const key = pbStringAt(fields, 3); // ApiKey.key — plaintext, only on create
  if (!key) {
    return failed("The control plane created a key but didn't return its value.");
  }
  return { ok: true, key, keyId: pbStringAt(fields, 1), userName, failure: "" };
}

/**
 * Exchange a Cognito id_token for an fw_ API key under the principal's first
 * account — the non-interactive path (tests, and any caller that doesn't
 * supply a picker). Interactive browser sign-in uses
 * listAccountsForIdToken + mintApiKeyForAccount so it can prompt when the
 * principal belongs to more than one account.
 * @param {string} idToken
 * @param {{ email?: string, baseUrl?: string, keyName?: string }} [options]
 * @returns {Promise<MintResult>}
 */
export async function mintApiKeyFromIdToken(idToken, options = {}) {
  const listed = await listAccountsForIdToken(idToken, { baseUrl: options.baseUrl ?? GATEWAY_GRPC_WEB_URL });
  if (!listed.ok) {
    return failed(listed.failure);
  }
  const accountName = listed.accountNames[0] ?? "";
  if (!accountName) {
    return failed(BROWSER_SIGNIN_NO_ACCOUNT_FAILURE);
  }
  return mintApiKeyForAccount(idToken, accountName, options);
}

/**
 * Where the CLI remembers the key it minted, so `logout` can revoke it
 * server-side — "reversible" should undo the remote side effect too, not
 * just the local copy. Holds ids only, never key material.
 * @param {string} home
 */
export function mintedKeyStatePath(home) {
  return path.join(home, ".nexus", "minted-key.json");
}

/**
 * @param {string} home
 * @param {{ keyId: string, userName: string, displayName: string }} state
 */
export async function writeMintedKeyState(home, { keyId, userName, displayName }) {
  await writeJson(mintedKeyStatePath(home), {
    keyId,
    userName,
    displayName,
    createdAt: new Date().toISOString(),
  });
}

/**
 * @param {string} home
 * @returns {Promise<{ keyId: string, userName: string, displayName: string } | null>}
 */
export async function readMintedKeyState(home) {
  const state = await readJsonIfExists(mintedKeyStatePath(home));
  return typeof state.keyId === "string" && state.keyId && typeof state.userName === "string" && state.userName
    ? { keyId: state.keyId, userName: state.userName, displayName: typeof state.displayName === "string" ? state.displayName : "" }
    : null;
}

/** @param {string} home */
export async function clearMintedKeyState(home) {
  await rm(mintedKeyStatePath(home), { force: true });
}

/**
 * Delete the API key this CLI minted, authenticating with the key itself —
 * the gateway accepts fw_ keys via x-api-key (authn.go), and a key may
 * delete its own record. Never throws.
 * @param {{ apiKey: string, keyId: string, userName: string, baseUrl?: string }} args
 * @returns {Promise<{ ok: boolean, failure: string }>}
 */
export async function revokeMintedKey({ apiKey, keyId, userName, baseUrl = GATEWAY_GRPC_WEB_URL }) {
  // DeleteApiKeyRequest{ parent = user resource, key_id } (gateway/api_key.proto)
  const request = Buffer.concat([pbString(1, userName), pbString(2, keyId)]);
  let result;
  try {
    result = await grpcWebCall(baseUrl, "DeleteApiKey", request, { apiKey });
  } catch (error) {
    return { ok: false, failure: `couldn't reach the Fireworks control plane (${error?.message ?? "network error"})` };
  }
  if (result.status !== 0) {
    return { ok: false, failure: result.detail ? `the control plane refused: ${result.detail}` : `the control plane refused (status ${result.status})` };
  }
  return { ok: true, failure: "" };
}

/**
 * Both List*Response messages put the resources in field 1 and each
 * resource's name in field 1 — decode two levels and return every resource
 * name. ListAccounts callers choose among them; ListUsers callers expect one
 * (the email filter) and treat more than one without an email as ambiguous.
 * @param {Buffer} message
 */
function allResourceNames(message) {
  const out = [];
  for (const entry of pbDecode(message).get(1) ?? []) {
    if (Buffer.isBuffer(entry)) {
      const name = pbStringAt(pbDecode(entry), 1);
      if (name) {
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * @param {string} doing
 * @param {import("../auth/grpc-web.mjs").GrpcWebResult} result
 */
function rpcFailureLine(doing, result) {
  if (result.status === 16) {
    return `Your browser sign-in wasn't accepted while ${doing} — try again, or use nexus login --paste. `
      + BROWSER_SSO_UNSUPPORTED_HINT;
  }
  return `Something went wrong ${doing}${result.detail ? ` (${result.detail})` : ` (status ${result.status})`}.`;
}
