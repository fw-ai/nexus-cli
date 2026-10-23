import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { after, before, describe, it } from "node:test";
import { grpcWebCall, pbDecode, pbField, pbString, pbStringAt } from "../../lib/auth/grpc-web.mjs";
import { jwtClaims, signInViaDeviceFlow, signInViaLocalhostCallback } from "../../lib/auth/browser-auth.mjs";
import { listAccountsForIdToken, mintApiKeyForAccount, mintApiKeyFromIdToken, mintedKeyName } from "../../lib/keys/mint-api-key.mjs";

const EMAIL = "dev@example.com";

/** A structurally valid, unsigned JWT — the CLI only ever decodes the payload. */
function fakeJwt(claims) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}
const ID_TOKEN = fakeJwt({ email: EMAIL, exp: 9999999999 });

/** @param {(req, res, body: Buffer) => void} handle */
function startServer(handle) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** Frame a protobuf message (+ OK trailers) the way a gRPC-web server does. */
function grpcWebFrames(message, { status = 0, detail = "" } = {}) {
  const frame = (flag, payload) => {
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const trailers = Buffer.from(`grpc-status: ${status}\r\n${detail ? `grpc-message: ${encodeURIComponent(detail)}\r\n` : ""}`);
  return message === null
    ? frame(0x80, trailers)
    : Buffer.concat([frame(0, message), frame(0x80, trailers)]);
}

describe("grpc-web codec", () => {
  it("round-trips strings and nested messages", () => {
    const message = Buffer.concat([
      pbString(1, "accounts/test"),
      pbField(2, pbString(2, "nexus-host")),
    ]);
    const fields = pbDecode(message);
    assert.equal(pbStringAt(fields, 1), "accounts/test");
    const nested = pbDecode(fields.get(2)[0]);
    assert.equal(pbStringAt(nested, 2), "nexus-host");
  });

  it("decodes varint fields and skips them cleanly", () => {
    // field 3, wire type 0 (varint 300) followed by a string field
    const message = Buffer.concat([Buffer.from([0x18, 0xac, 0x02]), pbString(1, "x")]);
    assert.equal(pbStringAt(pbDecode(message), 1), "x");
  });

  it("parses message + trailer frames and percent-decoded errors", async () => {
    const { server, url } = await startServer((req, res, body) => {
      // echo the request message back if authorized, else a trailer-only error
      const authed = req.headers.authorization === "bearer good-token";
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      if (!authed) {
        res.end(frameError());
        return;
      }
      res.end(grpcWebFrames(body.subarray(5)));
    });
    function frameError() {
      const trailers = Buffer.from("grpc-status: 16\r\ngrpc-message: bad%20token\r\n");
      const head = Buffer.alloc(5);
      head[0] = 0x80;
      head.writeUInt32BE(trailers.length, 1);
      return Buffer.concat([head, trailers]);
    }

    const ok = await grpcWebCall(url, "Echo", pbString(1, "hello"), "good-token");
    assert.equal(ok.status, 0);
    assert.equal(pbStringAt(pbDecode(ok.message), 1), "hello");

    const denied = await grpcWebCall(url, "Echo", pbString(1, "hello"), "bad");
    assert.equal(denied.status, 16);
    assert.equal(denied.detail, "bad token");
    assert.equal(denied.message, null);

    server.close();
  });
});

describe("device flow", () => {
  const noSleep = () => Promise.resolve();

  /** Device-auth mock whose poll responses follow a script. */
  function startDeviceService(pollScript) {
    let polls = 0;
    return startServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("grant_type")) {
        const step = pollScript[Math.min(polls, pollScript.length - 1)];
        polls += 1;
        res.writeHead(step.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(step.body));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        device_code: "dev-code",
        user_code: "ABCD-1234",
        verification_uri: "http://example.test/device",
        verification_uri_complete: "http://example.test/device?code=ABCD-1234",
        interval: 1,
        expires_in: 300,
      }));
    });
  }

  it("polls through pending and slow_down to tokens", async () => {
    const { server, url } = await startDeviceService([
      { ok: false, body: { error: "authorization_pending" } },
      { ok: false, body: { error: "slow_down" } },
      { ok: true, body: { id_token: ID_TOKEN, refresh_token: "r", expires_in: 3600 } },
    ]);
    const lines = [];
    const result = await signInViaDeviceFlow({
      serviceUrl: url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      sleep: noSleep,
    });
    assert.equal(result.ok, true);
    assert.equal(result.email, EMAIL);
    assert.ok(lines.some((l) => l.includes("ABCD-1234")), "shows the one-time code");
    server.close();
  });

  it("treats denial as fatal (no paste fallback)", async () => {
    const { server, url } = await startDeviceService([{ ok: false, body: { error: "denied" } }]);
    const result = await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    server.close();
  });

  it("stops on expired_token with a recovery line", async () => {
    const { server, url } = await startDeviceService([{ ok: false, body: { error: "expired_token" } }]);
    const result = await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.match(result.failure, /expired/);
    server.close();
  });

  it("fails softly when the service is unreachable (it is torn down today)", async () => {
    const result = await signInViaDeviceFlow({
      serviceUrl: "http://127.0.0.1:1",
      openBrowser: false,
      sleep: noSleep,
    });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.match(result.failure, /Couldn't reach/);
  });
});

describe("localhost callback flow", () => {
  let cognito;

  before(async () => {
    cognito = await startServer((req, res, body) => {
      if (req.url !== "/oauth2/token") {
        res.writeHead(404);
        res.end();
        return;
      }
      const params = new URLSearchParams(body.toString());
      const ok = params.get("grant_type") === "authorization_code"
        && params.get("code") === "good-code"
        && Boolean(params.get("code_verifier"));
      res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(ok
        ? JSON.stringify({ id_token: ID_TOKEN, access_token: "a", refresh_token: "r", expires_in: 3600 })
        : JSON.stringify({ error: "invalid_grant" }));
    });
  });

  after(() => {
    cognito.server.close();
  });

  /** Pull state out of the authorize URL the flow prints via onStatus. */
  function stateFrom(lines) {
    const url = /https?:\S+/.exec(lines.join("\n"))?.[0];
    return { url, state: new URL(url).searchParams.get("state") };
  }

  it("ignores stray requests, honors state, and exchanges the code (PKCE)", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // listener up
    const { state } = stateFrom(lines);
    assert.ok(state, "authorize URL with state was printed");

    // wrong path, wrong state, and forged errors (any local page can fire
    // these cross-origin) are all ignored, not fatal
    await fetch("http://localhost:18000/favicon.ico");
    await fetch(`http://localhost:18000/?code=evil&state=wrong`);
    await fetch("http://localhost:18000/?error=access_denied");
    await fetch(`http://localhost:18000/?error=server_error&state=wrong`);
    const landing = await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    assert.match(await landing.text(), /return to your terminal/i);

    const result = await pending;
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.email, EMAIL);
  });

  it("treats access_denied with the matching state as fatal", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { state } = stateFrom(lines);
    await fetch(`http://localhost:18000/?error=access_denied&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
  });

  it("times out with a one-line failure instead of hanging", async () => {
    const result = await signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: () => {},
      timeoutMs: 100,
    });
    assert.equal(result.ok, false);
    assert.match(result.failure, /Timed out/);
  });

  it("surfaces a rejected code exchange as a soft failure", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { state } = stateFrom(lines);
    await fetch(`http://localhost:18000/?code=stale-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.match(result.failure, /invalid_grant/);
  });

  it("prints the sign-in URL alongside the opened-browser line", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: true, // pin: the runner itself may be an SSH session
      open: async () => true,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(lines.join("\n"), /Opened your browser/);
    assert.match(lines.join("\n"), /If nothing opened/);
    const { state } = stateFrom(lines);
    assert.ok(state, "the authorize URL was printed as a fallback");
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("skips the opener entirely in a remote (SSH) session and prints the URL", async () => {
    process.env.SSH_TTY = "/dev/pts/7";
    try {
      const lines = [];
      let openerCalled = false;
      const pending = signInViaLocalhostCallback({
        cognitoDomain: cognito.url,
        open: async () => { openerCalled = true; return true; },
        onStatus: (line) => lines.push(line),
        timeoutMs: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(openerCalled, false, "no opener attempt on SSH");
      assert.match(lines.join("\n"), /Open this URL to sign in/);
      const { state } = stateFrom(lines);
      await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
      const result = await pending;
      assert.equal(result.ok, true, result.failure);
    } finally {
      delete process.env.SSH_TTY;
    }
  });

  it("prints the URL and keeps listening when no browser can be opened", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: true, // pin: the runner itself may be an SSH session
      open: async () => false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(lines.join("\n"), /Couldn't open a browser here/);
    assert.match(lines.join("\n"), /login --paste/);
    // The wait is NOT abandoned: the printed URL still completes sign-in
    // (WSL's Windows browser, an SSH port-forward).
    const { state } = stateFrom(lines);
    assert.ok(state, "the authorize URL was printed");
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });
});

describe("mint-api-key", () => {
  /** gRPC-web gateway mock: ListAccounts → ListUsers → CreateApiKey. */
  function startGateway({ minted = "fw_minted_key_0000000000000000000", authorized = true, accounts = ["accounts/test"], users = ["dev"] } = {}) {
    return startServer((req, res, body) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      if (!authorized || req.headers.authorization !== `bearer ${ID_TOKEN}`) {
        res.end(grpcWebFrames(null, { status: 16 }));
        return;
      }
      const message = body.subarray(5);
      if (req.url.endsWith("/ListAccounts")) {
        res.end(grpcWebFrames(Buffer.concat(accounts.map((a) => pbField(1, pbString(1, a))))));
      } else if (req.url.endsWith("/ListUsers")) {
        const fields = pbDecode(message);
        const parent = pbStringAt(fields, 1);
        assert.match(parent, /^accounts\//);
        // An email filter narrows to one user; without it (no email claim in
        // the id_token) every configured user comes back, like the real API.
        let matched = users;
        if (pbStringAt(fields, 4)) {
          assert.match(pbStringAt(fields, 4), /email="dev@example\.com"/);
          matched = users.slice(0, 1);
        }
        res.end(grpcWebFrames(Buffer.concat(matched.map((u) => pbField(1, pbString(1, `${parent}/users/${u}`))))));
      } else if (req.url.endsWith("/CreateApiKey")) {
        const fields = pbDecode(message);
        const parent = pbStringAt(fields, 1);
        assert.match(parent, /^accounts\/.+\/users\/dev$/);
        const apiKey = pbDecode(fields.get(2)[0]);
        assert.match(pbStringAt(apiKey, 2), /^nexus-/);
        res.end(grpcWebFrames(Buffer.concat([
          pbString(1, "key_test123"),
          pbString(2, pbStringAt(apiKey, 2)),
          pbString(3, minted),
        ])));
      } else {
        res.end(grpcWebFrames(null, { status: 12 }));
      }
    });
  }

  it("walks account → user → key and returns the plaintext once", async () => {
    const { server, url } = await startGateway();
    const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.key, "fw_minted_key_0000000000000000000");
    assert.equal(result.keyId, "key_test123");
    assert.equal(result.userName, "accounts/test/users/dev");
    server.close();
  });

  it("listAccountsForIdToken returns every account so the caller can pick", async () => {
    const { server, url } = await startGateway({ accounts: ["accounts/acme", "accounts/personal"] });
    try {
      const listed = await listAccountsForIdToken(ID_TOKEN, { baseUrl: url });
      assert.equal(listed.ok, true, listed.failure);
      assert.deepEqual(listed.accountNames, ["accounts/acme", "accounts/personal"]);
    } finally {
      server.close();
    }
  });

  it("mintApiKeyForAccount mints under the chosen account; the wrapper takes the first", async () => {
    const { server, url } = await startGateway({ accounts: ["accounts/acme", "accounts/personal"] });
    try {
      const picked = await mintApiKeyForAccount(ID_TOKEN, "accounts/personal", { email: EMAIL, baseUrl: url });
      assert.equal(picked.ok, true, picked.failure);
      assert.equal(picked.userName, "accounts/personal/users/dev");

      // The non-interactive wrapper still defaults to the first account.
      const first = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
      assert.equal(first.ok, true, first.failure);
      assert.equal(first.userName, "accounts/acme/users/dev");
    } finally {
      server.close();
    }
  });

  it("refuses to guess among users when the sign-in has no email claim", async () => {
    const { server, url } = await startGateway({ users: ["alice", "bob"] });
    try {
      const result = await mintApiKeyForAccount(ID_TOKEN, "accounts/test", { baseUrl: url });
      assert.equal(result.ok, false);
      assert.match(result.failure, /didn't say which/);
      assert.match(result.failure, /--paste/);
    } finally {
      server.close();
    }
  });

  it("mints without an email claim when the account has exactly one user", async () => {
    const { server, url } = await startGateway();
    try {
      const result = await mintApiKeyForAccount(ID_TOKEN, "accounts/test", { baseUrl: url });
      assert.equal(result.ok, true, result.failure);
      assert.equal(result.userName, "accounts/test/users/dev");
    } finally {
      server.close();
    }
  });

  it("says the caller isn't a member on a bare ListUsers denial, and keeps a denial's reason", async () => {
    let detail = "";
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(grpcWebFrames(null, { status: 7, detail }));
    });
    try {
      const bare = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url });
      assert.equal(bare.ok, false);
      assert.match(bare.failure, /not a member of "example-account"/);

      detail = "SSO authentication is required";
      const explained = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url });
      assert.equal(explained.ok, false);
      assert.match(explained.failure, /SSO authentication is required/);
      assert.doesNotMatch(explained.failure, /not a member/);
    } finally {
      server.close();
    }
  });

  it("maps an unauthenticated token to a --paste recovery line", async () => {
    const { server, url } = await startGateway({ authorized: false });
    const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
    assert.equal(result.ok, false);
    assert.match(result.failure, /--paste/);
    server.close();
  });

  it("fails softly when the control plane is unreachable", async () => {
    const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: "http://127.0.0.1:1" });
    assert.equal(result.ok, false);
    assert.match(result.failure, /Couldn't reach/);
  });

  it("names keys nexus-{hostname}, sanitized", () => {
    assert.equal(mintedKeyName("Roberts-MacBook-Pro.local"), "nexus-roberts-macbook-pro");
    assert.equal(mintedKeyName("host_with.dots"), "nexus-host-with");
    assert.equal(mintedKeyName(""), "nexus-cli");
  });

  it("jwtClaims decodes without verifying and tolerates garbage", () => {
    assert.equal(jwtClaims(ID_TOKEN).email, EMAIL);
    assert.deepEqual(jwtClaims("not-a-jwt"), {});
  });
});
