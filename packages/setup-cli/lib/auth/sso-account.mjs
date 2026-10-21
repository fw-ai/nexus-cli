import { Buffer } from "node:buffer";
import { grpcWebCall, pbDecode, pbField, pbString, pbStringAt } from "./grpc-web.mjs";
import { GATEWAY_GRPC_WEB_URL } from "../keys/mint-api-key.mjs";

/**
 * Enterprise SSO sign-in support, mirroring `firectl signin <account-id>`.
 *
 * Two unary gRPC-web calls against the gateway:
 *
 * - GetOAuthArguments (unauthenticated; sign_in.proto) resolves an account's
 *   OAuth config — for custom-SSO accounts, the tenant issuer/client/domain
 *   whose hosted UI federates to the org's identity provider. Feeding these
 *   into the existing localhost-callback flow is the whole SSO mechanism;
 *   the gateway's auth is multi-issuer (authn.go getOIDCArgs), so tokens
 *   from the tenant issuer work on the same mint path as developer tokens.
 *
 * - CreateUser with an empty user (user.proto) is JIT self-provisioning:
 *   the server extracts the email from the SSO token and creates the user
 *   in the account, gated server-side on the account's IdP having JIT
 *   enabled and the email domain allowlisted. AlreadyExists means the user
 *   was pre-added or has signed in before — equally fine.
 */

const GRPC_ALREADY_EXISTS = 6;
const GRPC_PERMISSION_DENIED = 7;

/**
 * @typedef {Object} OAuthArgsResult
 * @property {boolean} ok
 * @property {string} issuerUrl      OIDC issuer (may be "" even on ok).
 * @property {string} clientId       OAuth client id for the hosted UI.
 * @property {string} cognitoDomain  Hosted-UI base URL (https://… normalized).
 * @property {string} failure        One-line reason for the terminal ("" when ok).
 */

const failedArgs = (failure) => ({ ok: false, issuerUrl: "", clientId: "", cognitoDomain: "", failure });

/**
 * The gateway stores the domain as a URL (firectl url.Parse()s it verbatim),
 * but normalize defensively: no scheme → https, no trailing slash.
 * @param {string} domain
 */
function normalizeCognitoDomain(domain) {
  const trimmed = domain.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Resolve the OAuth arguments for an account's sign-in.
 * @param {string} accountId  bare id, e.g. "my-company"
 * @param {{ baseUrl?: string }} [options]
 * @returns {Promise<OAuthArgsResult>}
 */
export async function getOAuthArgumentsForAccount(accountId, { baseUrl = GATEWAY_GRPC_WEB_URL } = {}) {
  const id = accountId?.trim() ?? "";
  if (!id) {
    return failedArgs("No account ID given.");
  }
  let result;
  try {
    result = await grpcWebCall(baseUrl, "GetOAuthArguments", pbString(1, id), "");
  } catch (error) {
    return failedArgs(`Couldn't reach the Fireworks control plane (${error?.message ?? "network error"}).`);
  }
  if (result.status !== 0 || !result.message) {
    // The server answers PERMISSION_DENIED for unknown accounts — don't
    // leak-guess; the recovery is the same either way.
    return failedArgs(
      `Couldn't find SSO sign-in configuration for account "${id}". Check the account ID with your admin, or use nexus login --paste.`,
    );
  }
  const fields = pbDecode(result.message);
  const clientId = pbStringAt(fields, 2);
  const cognitoDomain = normalizeCognitoDomain(pbStringAt(fields, 3));
  if (!clientId || !cognitoDomain) {
    return failedArgs(
      `Account "${id}" has no SSO sign-in configured. Check the account ID with your admin, or use nexus login --paste.`,
    );
  }
  return { ok: true, issuerUrl: pbStringAt(fields, 1), clientId, cognitoDomain, failure: "" };
}

/**
 * JIT self-provisioning after an SSO sign-in (mirrors firectl signin):
 * CreateUser{parent: accounts/<id>, user: {}} — the server fills the email
 * in from the SSO token. Three meaningful outcomes:
 *   created / AlreadyExists  → ok (member, proceed)
 *   PermissionDenied         → not a member and JIT can't add them — the
 *                              account admin has to. Actionable, not retryable.
 * @param {string} idToken
 * @param {string} accountId  bare id, e.g. "my-company"
 * @param {{ baseUrl?: string }} [options]
 * @returns {Promise<{ ok: boolean, failure: string }>}
 */
export async function createUserJit(idToken, accountId, { baseUrl = GATEWAY_GRPC_WEB_URL } = {}) {
  const request = Buffer.concat([
    pbString(1, `accounts/${accountId}`),
    pbField(2, Buffer.alloc(0)),
  ]);
  let result;
  try {
    result = await grpcWebCall(baseUrl, "CreateUser", request, idToken);
  } catch (error) {
    return { ok: false, failure: `Couldn't reach the Fireworks control plane (${error?.message ?? "network error"}).` };
  }
  if (result.status === 0 || result.status === GRPC_ALREADY_EXISTS) {
    return { ok: true, failure: "" };
  }
  if (result.status === GRPC_PERMISSION_DENIED) {
    return {
      ok: false,
      failure: `You signed in, but you're not a member of "${accountId}" yet — ask your account admin to add you.`,
    };
  }
  return {
    ok: false,
    failure: `Something went wrong joining "${accountId}"${result.detail ? ` (${result.detail})` : ` (status ${result.status})`}.`,
  };
}
