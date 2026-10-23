import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { link, openInBrowser } from "../ui/term.mjs";
import { isRemoteContext } from "../config/remote-context.mjs";
import { CLI_COLORS } from "../ui/tokens.mjs";

/**
 * Browser sign-in for `nexus login`.
 *
 * Primary flow: OAuth authorization-code + PKCE against the Cognito hosted UI,
 * catching the redirect on http://localhost:18000 — the redirect URI already
 * registered on the developer app client (firectl signin uses the same one).
 *
 * Fallback flow (SSH / --no-browser): the RFC 8628 device-authorization
 * service at device-auth.fireworks.ai. The client is complete, but the
 * service's ALB is currently torn down (dangling CNAME, no IaC) — init fails
 * with a network error and callers degrade to the paste flow. When the
 * service is redeployed this lights up with no CLI change.
 *
 * Both flows yield a Cognito id_token; mint-api-key.mjs exchanges that for
 * the fw_ key everything downstream of auth actually uses.
 *
 * The client id, domains, and pool id are public values (the app client is a
 * public OAuth client — no secret exists). Env overrides are for pointing at
 * the dev pool during development.
 */
export const OAUTH_CLIENT_ID = process.env.NEXUS_OAUTH_CLIENT_ID?.trim()
  || "sueas7prsfrdp16nantbeqcjv";
export const COGNITO_DOMAIN = process.env.NEXUS_COGNITO_DOMAIN?.trim()
  || "https://fireworks.auth.us-west-2.amazoncognito.com";
export const COGNITO_POOL_ID = process.env.NEXUS_COGNITO_POOL_ID?.trim()
  || "us-west-2_feAWJl2Gd";
export const DEVICE_AUTH_URL = process.env.NEXUS_DEVICE_AUTH_URL?.trim()
  || "https://device-auth.fireworks.ai";

/** The exact redirect URI registered on the Cognito app client (root path, port 18000). */
export const CALLBACK_URI = "http://localhost:18000";
const CALLBACK_PORT = 18000;
const CALLBACK_TIMEOUT_MS = 300_000;

const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Decode a JWT payload without verifying the signature — same as
 * `firectl whoami`; we only read the email for display, the token's real
 * validation happens server-side when it mints the key.
 * @param {string} token
 * @returns {Record<string, unknown>}
 */
export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * @typedef {Object} TokenResult
 * @property {boolean} ok
 * @property {string} idToken     Cognito id_token ("" on failure).
 * @property {string} email       email claim from the id_token (may be "").
 * @property {string} failure     One-line reason, phrased for the terminal ("" when ok).
 * @property {boolean} fatal      True when retrying another flow won't help (user denied).
 */

const failed = (failure, fatal = false) => ({ ok: false, idToken: "", email: "", failure, fatal });

/**
 * The HTML served on localhost after the redirect lands. Self-contained — no
 * external assets, the page must render without touching the network — and
 * static: only fixed strings we control are interpolated. Its only job is to
 * send the user back to the terminal.
 * @param {boolean} ok
 */
export function callbackPage(ok) {
  const title = ok ? "Signed in" : "Sign-in failed";
  const term = ok
    ? `<span style="color:#4ade80">✓</span> authenticated · return to your terminal`
    : `<span style="color:#c76b6b">✗</span> auth failed · return to your terminal to try again`;
  const fallback = ok
    ? ""
    : `\n<a class="fallback" href="https://app.fireworks.ai/settings/users/api-keys">Or use an API key instead</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Nexus</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#121212;color:#ededed;min-height:100vh;box-sizing:border-box;padding:24px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
.cb{width:360px;max-width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #2a2a2a;
  border-radius:16px;box-shadow:0 8px 44px rgba(0,0,0,.5);padding:40px 32px 34px;text-align:center}
.mark{width:88px;height:auto;display:block;margin:0 auto 24px;overflow:visible}
.mark path{fill:${ok ? CLI_COLORS.dark.primary : "#3a3a3a"}}
h1{margin:0 0 20px;font-size:24px;font-weight:600;letter-spacing:-.02em;
  font-family:"Space Grotesk","Avenir Next","Segoe UI",system-ui,sans-serif}
.term{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;
  background:#0e0e0e;border:1px solid #262626;border-radius:8px;padding:12px 14px;color:#a0a0a0}
.fallback{display:inline-block;margin-top:16px;font-size:13px;color:${CLI_COLORS.dark.accent};text-decoration:none}
.fallback:hover{text-decoration:underline}
.foot{font-size:12px;color:#777777}
@keyframes burst{0%{transform:scale(.2);opacity:0}60%{transform:scale(1.12);opacity:1}100%{transform:scale(1)}}
.mark g{transform-box:fill-box;transform-origin:center${ok ? ";animation:burst 520ms cubic-bezier(.2,.8,.2,1) both" : ""}}
@media(prefers-reduced-motion:reduce){.mark g{animation:none}}
</style></head>
<body>
<div class="cb">
<svg class="mark" viewBox="0 0 638 315" fill="none" aria-hidden="true"><g>
<path d="M318.563 221.755C300.863 221.755 284.979 211.247 278.206 194.978L196.549 0H244.342L318.842 178.361L393.273 0H441.066L358.92 195.048C352.112 211.247 336.263 221.755 318.563 221.755Z"/>
<path d="M425.111 314.933C407.481 314.933 391.667 304.494 384.824 288.366C377.947 272.097 381.507 253.524 393.936 240.921L542.657 90.2803L561.229 134.094L425.076 271.748L619.147 270.666L637.72 314.479L425.146 315.003L425.076 314.933H425.111Z"/>
<path d="M0 314.408L18.5727 270.595L212.643 271.677L76.525 133.988L95.0977 90.1748L243.819 240.816C256.247 253.384 259.843 272.026 252.93 288.26C246.088 304.424 230.203 314.827 212.643 314.827L0.0698221 314.339L0 314.408Z"/>
</g></svg>
<h1>${title}</h1>
<div class="term">${term}</div>${fallback}
</div>
<div class="foot">Nexus CLI · Fireworks AI</div>
</body></html>`;
}

/**
 * Wait for the OAuth redirect on localhost:18000. Resolves with the
 * authorization code once the browser lands, or a failure line on
 * error/timeout. `onListening` runs after the port is bound (the listener must
 * exist before the browser navigates) to print status and open the browser.
 * @param {string} authorizeUrl
 * @param {string} state
 * @param {(url: string) => Promise<void>} onListening
 * @param {{ timeoutMs?: number, port?: number }} [options]
 * @returns {Promise<{ code: string, failure: string, fatal: boolean }>}
 */
function waitForCallback(authorizeUrl, state, onListening, { timeoutMs = CALLBACK_TIMEOUT_MS, port = CALLBACK_PORT } = {}) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", CALLBACK_URI);
      // "Connection: close" everywhere: a lingering keep-alive socket would
      // otherwise outlive server.close() and hold the process open after
      // sign-in finishes.
      if (url.pathname !== "/") {
        res.writeHead(404, { Connection: "close" });
        res.end();
        return;
      }
      const error = url.searchParams.get("error") ?? "";
      const code = url.searchParams.get("code") ?? "";
      const stateOk = url.searchParams.get("state") === state;
      const ok = !error && stateOk && Boolean(code);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(callbackPage(ok));
      // A stray request shouldn't kill the wait unless Cognito reported a
      // real outcome — and "real" means the CSRF state matches, for errors
      // too (RFC 6749 §4.1.2.1 echoes state on error redirects). Otherwise
      // any local page could abort sign-in with a forged
      // /?error=access_denied fetch.
      if (ok) {
        finish({ code, failure: "", fatal: false });
      } else if (error === "access_denied" && stateOk) {
        finish({ code: "", failure: "Sign-in was cancelled in the browser.", fatal: true });
      } else if (error && stateOk) {
        finish({ code: "", failure: `The sign-in page reported an error (${error}).`, fatal: false });
      }
    });

    let timer = null;
    let settled = false;
    const finish = (result) => {
      // First outcome wins: the timeout and a callback in flight can race here.
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(result);
    };
    server.on("error", (error) => {
      finish({
        code: "",
        failure: error?.code === "EADDRINUSE"
          ? `Port ${port} is in use (is another sign-in running?).`
          : `Couldn't start the local sign-in listener (${error?.message ?? "unknown error"}).`,
        fatal: false,
      });
    });
    // Loopback only — the redirect is http://localhost, so nothing off-host
    // ever belongs here. Browsers that try ::1 first fall back to 127.0.0.1
    // when the connection is refused.
    server.listen(port, "127.0.0.1", async () => {
      timer = setTimeout(() => {
        finish({ code: "", failure: "Timed out waiting for the browser sign-in.", fatal: false });
      }, timeoutMs);
      await onListening(authorizeUrl);
    });
  });
}

/**
 * Primary flow: authorization-code + PKCE via the Cognito hosted UI, redirect
 * caught on localhost. `onStatus` receives user-facing progress lines.
 * `open` is the browser opener (injectable for tests).
 * @param {{ onStatus?: (line: string) => void, openBrowser?: boolean, open?: (url: string) => Promise<boolean>, cognitoDomain?: string, clientId?: string, timeoutMs?: number }} [options]
 * @returns {Promise<TokenResult>}
 */
export async function signInViaLocalhostCallback({
  onStatus = () => {},
  // On SSH/WSL a locally-opened browser can't reach the user — skip the
  // opener entirely and print the URL (it still completes sign-in via WSL's
  // Windows browser or an SSH port-forward to localhost:18000).
  openBrowser = !isRemoteContext(),
  open = openInBrowser,
  cognitoDomain = COGNITO_DOMAIN,
  clientId = OAUTH_CLIENT_ID,
  timeoutMs = CALLBACK_TIMEOUT_MS,
} = {}) {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const authorizeUrl = `${cognitoDomain}/oauth2/authorize?` + new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: CALLBACK_URI,
    state,
    code_challenge_method: "S256",
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
  }).toString();

  const { code, failure, fatal } = await waitForCallback(authorizeUrl, state, async (url) => {
    if (!openBrowser) {
      onStatus(`Open this URL to sign in:\n  ${link(url)}`);
      return;
    }
    if (await open(url)) {
      onStatus("Opened your browser — finish signing in there.");
      onStatus(`If nothing opened, sign in at:\n  ${link(url)}`);
      return;
    }
    onStatus(`Couldn't open a browser here. To sign in, open this URL in a browser on this machine:\n  ${link(url)}`);
    onStatus("Or press Ctrl+C and run  nexus login --paste  to paste a key instead.");
  }, { timeoutMs });
  if (!code) {
    return failed(failure, fatal);
  }

  let response;
  try {
    response = await fetch(`${cognitoDomain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: CALLBACK_URI,
        code_verifier: verifier,
      }),
    });
  } catch (error) {
    return failed(`Couldn't reach the sign-in service (${error?.message ?? "network error"}).`);
  }
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.id_token) {
    return failed(`The sign-in service rejected the browser sign-in (${tokens.error ?? response.status}).`);
  }
  const email = typeof jwtClaims(tokens.id_token).email === "string" ? jwtClaims(tokens.id_token).email : "";
  return { ok: true, idToken: tokens.id_token, email, failure: "", fatal: false };
}

/**
 * Fallback flow: RFC 8628 device authorization. Init returns the one-time
 * code and verification URLs; we poll until the user approves in a browser
 * (on any device). The service's error contract: HTTP 400 with
 * {"error": "authorization_pending" | "slow_down" | "expired_token" | "denied"}.
 * @param {{ onStatus?: (line: string) => void, openBrowser?: boolean, serviceUrl?: string, clientId?: string, cognitoDomain?: string, cognitoPoolId?: string, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<TokenResult>}
 */
export async function signInViaDeviceFlow({
  onStatus = () => {},
  // Same remote-session rule as the localhost flow; the device verification
  // URL works from any device, so printing it is the whole point here.
  openBrowser = !isRemoteContext(),
  serviceUrl = DEVICE_AUTH_URL,
  clientId = OAUTH_CLIENT_ID,
  cognitoDomain = COGNITO_DOMAIN,
  cognitoPoolId = COGNITO_POOL_ID,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const baseParams = {
    client_id: clientId,
    cognito_pool_id: cognitoPoolId,
    cognito_domain: cognitoDomain,
  };
  const tokenUrl = (extra = {}) =>
    `${serviceUrl}/token?${new URLSearchParams({ ...baseParams, ...extra }).toString()}`;
  const post = (url) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  let init;
  try {
    const response = await post(tokenUrl());
    init = await response.json().catch(() => null);
    if (!response.ok || !init?.device_code) {
      return failed(`Browser sign-in service returned an unexpected response (${response.status}).`);
    }
  } catch (error) {
    return failed(`Couldn't reach the browser sign-in service (${error?.message ?? "network error"}).`);
  }

  const verifyUrl = init.verification_uri_complete || init.verification_uri;
  onStatus(`Your one-time code is  ${init.user_code}`);
  if (openBrowser && await openInBrowser(verifyUrl)) {
    onStatus("Opened your browser — approve the sign-in there (the code is pre-filled).");
  } else {
    onStatus(`On any device, open  ${link(verifyUrl)}`);
  }

  let intervalMs = Math.max(1, Number(init.interval) || 10) * 1000;
  const deadline = Date.now() + (Number(init.expires_in) || 1800) * 1000;
  const pollUrl = tokenUrl({ device_code: init.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let response;
    try {
      response = await post(pollUrl);
    } catch {
      continue; // transient network blip mid-poll: keep waiting
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.id_token) {
      const email = typeof jwtClaims(body.id_token).email === "string" ? jwtClaims(body.id_token).email : "";
      return { ok: true, idToken: body.id_token, email, failure: "", fatal: false };
    }
    if (body.error === "authorization_pending") {
      continue;
    }
    if (body.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (body.error === "denied") {
      return failed("Sign-in was denied in the browser.", true);
    }
    if (body.error === "expired_token") {
      return failed("The sign-in code expired before it was approved.");
    }
    return failed(`Browser sign-in failed (${body.error || `HTTP ${response.status}`}).`);
  }
  return failed("The sign-in code expired before it was approved.");
}
