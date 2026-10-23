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
 * Primary flow: OAuth authorization-code + PKCE against Cognito, catching the
 * redirect on http://localhost:18000 — the redirect URI already registered on
 * the developer app client (firectl signin uses the same one). For the
 * developer pool the browser starts on a Nexus-branded page served by that
 * listener rather than Cognito's unbranded hosted UI.
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

export const COGNITO_IDP_URL = process.env.NEXUS_COGNITO_IDP_URL?.trim()
  || `https://cognito-idp.${COGNITO_POOL_ID.split("_")[0]}.amazonaws.com/`;

/** The exact redirect URI registered on the Cognito app client (root path, port 18000). */
export const CALLBACK_URI = "http://localhost:18000";
const CALLBACK_PORT = 18000;
const CALLBACK_TIMEOUT_MS = 300_000;

/** Nexus-branded sign-in page served by the local listener instead of the Cognito hosted UI. */
export const SIGNIN_PAGE_URI = `${CALLBACK_URI}/signin`;
const EMAIL_SIGNIN_PATH = "/signin/email";
const LOOPBACK_HOSTS = new Set([`localhost:${CALLBACK_PORT}`, `127.0.0.1:${CALLBACK_PORT}`]);
const LOOPBACK_ORIGINS = new Set([...LOOPBACK_HOSTS].map((host) => `http://${host}`));
const MAX_FORM_BYTES = 16 * 1024;

/**
 * Identity providers federated into the shared developer pool, by their
 * Cognito provider names (auth/multi_tenant.tf). Same set and labels as the
 * web Nexus login page.
 */
export const DEVELOPER_IDENTITY_PROVIDERS = Object.freeze([
  Object.freeze({ id: "Google", label: "Continue with Google" }),
  Object.freeze({ id: "GitHub", label: "Continue with GitHub" }),
  Object.freeze({ id: "LinkedIn", label: "Continue with LinkedIn" }),
]);
const SIGNUP_URL = "https://app.fireworks.ai/nexus/signup";
const FORGOT_PASSWORD_URL = "https://app.fireworks.ai/forgot-password";

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

/**
 * @typedef {Object} CallbackResult
 * @property {string} code        Authorization code from the "/" redirect ("" otherwise).
 * @property {string} [idToken]   id_token from the email sign-in (no code exchange needed).
 * @property {string} failure
 * @property {boolean} fatal
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
${MARK_SVG}
<h1>${title}</h1>
<div class="term">${term}</div>${fallback}
</div>
<div class="foot">Nexus CLI · Fireworks AI</div>
</body></html>`;
}

const MARK_SVG = `<svg class="mark" viewBox="0 0 638 315" fill="none" aria-hidden="true"><g>
<path d="M318.563 221.755C300.863 221.755 284.979 211.247 278.206 194.978L196.549 0H244.342L318.842 178.361L393.273 0H441.066L358.92 195.048C352.112 211.247 336.263 221.755 318.563 221.755Z"/>
<path d="M425.111 314.933C407.481 314.933 391.667 304.494 384.824 288.366C377.947 272.097 381.507 253.524 393.936 240.921L542.657 90.2803L561.229 134.094L425.076 271.748L619.147 270.666L637.72 314.479L425.146 315.003L425.076 314.933H425.111Z"/>
<path d="M0 314.408L18.5727 270.595L212.643 271.677L76.525 133.988L95.0977 90.1748L243.819 240.816C256.247 253.384 259.843 272.026 252.93 288.26C246.088 304.424 230.203 314.827 212.643 314.827L0.0698221 314.339L0 314.408Z"/>
</g></svg>`;

const PROVIDER_ICONS = {
  Google: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>`,
  GitHub: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#ededed" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>`,
  LinkedIn: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0A66C2" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>`,
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

/**
 * The Nexus-branded sign-in page served on localhost: one button per
 * federated provider (each goes straight to /oauth2/authorize with
 * identity_provider set, so Cognito's hosted UI never renders) plus an
 * email/password form posted back to the local listener. Self-contained like
 * callbackPage; every interpolated value is escaped.
 * @param {{ authorizeUrl: string, providers: ReadonlyArray<{ id: string, label: string }>, csrf: string, error?: string, email?: string }} options
 */
export function signInPage({ authorizeUrl, providers, csrf, error = "", email = "" }) {
  const providerButtons = providers.map(({ id, label }) => {
    const href = `${authorizeUrl}&${new URLSearchParams({ identity_provider: id }).toString()}`;
    return `<a class="btn" href="${escapeHtml(href)}">${PROVIDER_ICONS[id] ?? ""}<span>${escapeHtml(label)}</span></a>`;
  }).join("\n");
  const errorLine = error ? `\n<div class="error" role="alert">${escapeHtml(error)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Nexus</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#121212;color:#ededed;min-height:100vh;box-sizing:border-box;padding:24px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
.cb{width:380px;max-width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #2a2a2a;
  border-radius:16px;box-shadow:0 8px 44px rgba(0,0,0,.5);padding:36px 32px 30px}
.mark{width:72px;height:auto;display:block;margin:0 auto 20px;overflow:visible}
.mark path{fill:${CLI_COLORS.dark.primary}}
h1{margin:0;text-align:center;font-size:24px;font-weight:600;letter-spacing:-.02em;
  font-family:"Space Grotesk","Avenir Next","Segoe UI",system-ui,sans-serif}
.sub{margin:6px 0 24px;text-align:center;font-size:13px;color:#a0a0a0}
.providers{display:flex;flex-direction:column;gap:8px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;height:40px;box-sizing:border-box;
  border:1px solid #333;border-radius:8px;background:#202020;color:#ededed;font-size:13px;text-decoration:none;
  cursor:pointer;width:100%;font-family:inherit}
.btn:hover{background:#2a2a2a;border-color:#444}
.btn svg{width:16px;height:16px}
.or{display:flex;align-items:center;gap:12px;margin:20px 0;color:#777;font-size:12px}
.or::before,.or::after{content:"";flex:1;height:1px;background:#2a2a2a}
form{display:flex;flex-direction:column;gap:10px}
input{height:40px;box-sizing:border-box;border:1px solid #333;border-radius:8px;background:#0e0e0e;color:#ededed;
  padding:0 12px;font-size:13px;font-family:inherit}
input:focus{outline:none;border-color:${CLI_COLORS.dark.accent}}
.primary{background:${CLI_COLORS.dark.primary};border-color:${CLI_COLORS.dark.primary};color:#121212;font-weight:600}
.primary:hover{background:${CLI_COLORS.dark.accent};border-color:${CLI_COLORS.dark.accent}}
.error{margin-bottom:12px;padding:10px 12px;border:1px solid #5a2a2a;border-radius:8px;background:#2a1616;
  color:#f0b4b4;font-size:13px}
.links{display:flex;justify-content:space-between;margin-top:18px;font-size:12px;color:#a0a0a0}
.links a{color:${CLI_COLORS.dark.accent};text-decoration:none}
.links a:hover{text-decoration:underline}
.foot{font-size:12px;color:#777777}
</style></head>
<body>
<div class="cb">
${MARK_SVG}
<h1>Welcome to Nexus</h1>
<p class="sub">Sign in to connect your coding tools to Fireworks</p>${errorLine}
<div class="providers">
${providerButtons}
</div>
<div class="or">OR</div>
<form method="post" action="${EMAIL_SIGNIN_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="email" name="email" placeholder="Email" autocomplete="email" required value="${escapeHtml(email)}">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
<button class="btn primary" type="submit">Sign in with email</button>
</form>
<div class="links">
<span>New to Nexus? <a href="${SIGNUP_URL}">Create an account</a></span>
<a href="${FORGOT_PASSWORD_URL}">Forgot password?</a>
</div>
</div>
<div class="foot">Nexus CLI · Fireworks AI</div>
</body></html>`;
}

/**
 * Email/password sign-in against the Cognito user-pool API (USER_PASSWORD_AUTH,
 * the same app client the web login uses). Any challenge (new password, MFA)
 * or unconfirmed account can't be finished here, so it maps to a line that
 * points the user at the web app.
 * @param {{ idpUrl: string, clientId: string, email: string, password: string }} options
 * @returns {Promise<{ idToken: string, error: string }>}
 */
export async function initiatePasswordAuth({ idpUrl, clientId, email, password }) {
  let response;
  try {
    response = await fetch(idpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    });
  } catch (error) {
    return { idToken: "", error: `Couldn't reach the sign-in service (${error?.message ?? "network error"}). Try again.` };
  }
  const body = await response.json().catch(() => ({}));
  const idToken = body?.AuthenticationResult?.IdToken;
  if (response.ok && idToken) {
    return { idToken, error: "" };
  }
  const type = String(body?.__type ?? "").split("#").pop();
  if (type === "NotAuthorizedException") {
    return { idToken: "", error: "Incorrect email or password." };
  }
  if (type === "UserNotConfirmedException") {
    return { idToken: "", error: "Verify your email first: finish signing up at app.fireworks.ai, then try again." };
  }
  if (type === "PasswordResetRequiredException") {
    return { idToken: "", error: "Your password needs to be reset. Use “Forgot password?” below, then try again." };
  }
  if (type === "TooManyRequestsException" || type === "LimitExceededException") {
    return { idToken: "", error: "Too many attempts. Wait a minute and try again." };
  }
  if (response.ok && body?.ChallengeName) {
    return { idToken: "", error: "This account needs an extra sign-in step. Sign in once at app.fireworks.ai, then try again." };
  }
  return { idToken: "", error: `Sign-in failed (${type || `HTTP ${response.status}`}). Try again or use a provider above.` };
}

/** @param {import("node:http").IncomingMessage} req */
function readForm(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => resolve(null));
  });
}

/**
 * Wait for the OAuth redirect on localhost:18000. Resolves with the
 * authorization code once the browser lands, or a failure line on
 * error/timeout. `onListening` runs after the port is bound (the listener must
 * exist before the browser navigates) to print status and open the browser.
 * @param {string} authorizeUrl
 * @param {string} state
 * @param {(url: string) => Promise<void>} onListening
 * `extraRoute` gets first look at every request other than the "/" redirect
 * and returns true when it handled it; it may settle the wait through
 * `finish` (the email sign-in does, with an id_token instead of a code).
 * @param {{ timeoutMs?: number, port?: number, extraRoute?: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL, finish: (result: CallbackResult) => void) => boolean }} [options]
 * @returns {Promise<CallbackResult>}
 */
function waitForCallback(authorizeUrl, state, onListening, { timeoutMs = CALLBACK_TIMEOUT_MS, port = CALLBACK_PORT, extraRoute } = {}) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", CALLBACK_URI);
      if (url.pathname !== "/" && extraRoute?.(req, res, url, finish)) {
        return;
      }
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
 * Routes for the branded sign-in page: GET /signin renders it, POST
 * /signin/email runs the password sign-in. Both refuse requests whose Host
 * isn't the loopback listener (DNS rebinding); the POST also needs a loopback
 * Origin when the browser sends one and the per-sign-in CSRF token, so no
 * other page can sign the CLI into someone else's account.
 * @param {{ authorizeUrl: string, providers: ReadonlyArray<{ id: string, label: string }>, state: string, idpUrl: string, clientId: string }} options
 */
function brandedSignInRoutes({ authorizeUrl, providers, state, idpUrl, clientId }) {
  const sendPage = (res, status, page) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self' https:; frame-ancestors 'none'",
      Connection: "close",
    });
    res.end(page);
  };
  const forbidden = (res) => {
    res.writeHead(403, { Connection: "close" });
    res.end();
  };
  const render = (res, status, extra = {}) =>
    sendPage(res, status, signInPage({ authorizeUrl, providers, csrf: state, ...extra }));

  return (req, res, url, finish) => {
    if (url.pathname !== "/signin" && url.pathname !== EMAIL_SIGNIN_PATH) {
      return false;
    }
    if (!LOOPBACK_HOSTS.has(req.headers.host ?? "")) {
      forbidden(res);
      return true;
    }
    if (url.pathname === "/signin" && req.method === "GET") {
      render(res, 200);
      return true;
    }
    if (url.pathname !== EMAIL_SIGNIN_PATH || req.method !== "POST") {
      res.writeHead(405, { Connection: "close" });
      res.end();
      return true;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !LOOPBACK_ORIGINS.has(origin)) {
      forbidden(res);
      return true;
    }
    readForm(req).then(async (form) => {
      if (!form || form.get("csrf") !== state) {
        forbidden(res);
        return;
      }
      const email = (form.get("email") ?? "").trim();
      const password = form.get("password") ?? "";
      if (!email || !password) {
        render(res, 400, { email, error: "Enter your email and password." });
        return;
      }
      const result = await initiatePasswordAuth({ idpUrl, clientId, email, password });
      if (!result.idToken) {
        render(res, 401, { email, error: result.error });
        return;
      }
      sendPage(res, 200, callbackPage(true));
      finish({ code: "", idToken: result.idToken, failure: "", fatal: false });
    });
    return true;
  };
}

/**
 * Primary flow: authorization-code + PKCE, redirect caught on localhost.
 * With `providers` (the shared developer pool) the browser opens the
 * Nexus-branded page served on localhost, whose buttons skip Cognito's hosted
 * UI and whose email form signs in directly; without them (tenant SSO pools)
 * it opens the pool's hosted UI. `onStatus` receives user-facing progress
 * lines. `open` is the browser opener (injectable for tests).
 * @param {{ onStatus?: (line: string) => void, openBrowser?: boolean, open?: (url: string) => Promise<boolean>, cognitoDomain?: string, clientId?: string, providers?: ReadonlyArray<{ id: string, label: string }> | null, idpUrl?: string, timeoutMs?: number }} [options]
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
  providers = null,
  idpUrl = COGNITO_IDP_URL,
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

  const extraRoute = providers
    ? brandedSignInRoutes({ authorizeUrl, providers, state, idpUrl, clientId })
    : undefined;
  const startUrl = providers ? SIGNIN_PAGE_URI : authorizeUrl;
  const { code, idToken, failure, fatal } = await waitForCallback(startUrl, state, async (url) => {
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
  }, { timeoutMs, extraRoute });
  if (idToken) {
    return tokenResult(idToken);
  }
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
  return tokenResult(tokens.id_token);
}

/** @param {string} idToken @returns {TokenResult} */
function tokenResult(idToken) {
  const email = typeof jwtClaims(idToken).email === "string" ? jwtClaims(idToken).email : "";
  return { ok: true, idToken, email, failure: "", fatal: false };
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
