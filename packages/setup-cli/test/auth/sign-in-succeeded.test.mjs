import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// In-memory secret store so persistApiKeyToKeychain never touches the real
// keychain. Read at call time, so setting it here (after imports) is enough.
process.env.NEXUS_SECRET_STORE ??= "memory";
process.env.NEXUS_TEST ??= "1";

import { persistApiKeyToKeychain } from "../../lib/keys/api-key.mjs";
import { resetSecretStoreForTests } from "../../lib/keys/secret-store.mjs";
import { signInSucceeded } from "../../lib/cli/commands/login.mjs";

const VALID_KEY = "fw_sis_valid_key_0000000000000000";
const REJECTED_KEY = "fw_sis_rejected_key_00000000000";

/** /verifyApiKey mock: 200 + identity headers for VALID_KEY, 401 otherwise. */
function startMockVerify() {
  const server = createServer((req, res) => {
    if (req.url !== "/verifyApiKey") {
      res.writeHead(404);
      res.end();
      return;
    }
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (key === VALID_KEY) {
      res.writeHead(200, {
        "x-fireworks-developer-email": "dev@example.com",
        "x-fireworks-account-id": "acct-sis",
      });
    } else {
      res.writeHead(401);
    }
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function withHome(prefix, fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), `fc-sis-${prefix}-`));
  // The in-memory store is module-global and pins a home; reset per test so the
  // seed lands for THIS home (same pattern as helpers.seedKeychainConfig).
  resetSecretStoreForTests();
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("signInSucceeded (#3: verify-as-success)", () => {
  let gateway;
  let savedUrl;
  let savedEnvKey;

  before(async () => {
    gateway = await startMockVerify();
    savedUrl = process.env.NEXUS_GATEWAY_URL;
    savedEnvKey = process.env.FIREWORKS_API_KEY;
    process.env.NEXUS_GATEWAY_URL = gateway.url;
    delete process.env.FIREWORKS_API_KEY;
  });

  after(() => {
    gateway.server.close();
    if (savedUrl === undefined) {
      delete process.env.NEXUS_GATEWAY_URL;
    } else {
      process.env.NEXUS_GATEWAY_URL = savedUrl;
    }
    if (savedEnvKey === undefined) {
      delete process.env.FIREWORKS_API_KEY;
    } else {
      process.env.FIREWORKS_API_KEY = savedEnvKey;
    }
  });

  it("false when no key is resolvable", async () => {
    await withHome("empty", async (home) => {
      delete process.env.FIREWORKS_API_KEY;
      assert.equal(await signInSucceeded(home), false);
    });
  });

  it("true for a stored key the API accepts", async () => {
    await withHome("ok", async (home) => {
      delete process.env.FIREWORKS_API_KEY;
      await persistApiKeyToKeychain(home, VALID_KEY);
      assert.equal(await signInSucceeded(home), true);
    });
  });

  it("false for a stored key the API rejects", async () => {
    await withHome("rejected", async (home) => {
      delete process.env.FIREWORKS_API_KEY;
      await persistApiKeyToKeychain(home, REJECTED_KEY);
      assert.equal(await signInSucceeded(home), false);
    });
  });

  it("false when a rejected FIREWORKS_API_KEY overrides a valid stored key", async () => {
    // The on-ramp #3 case: the flow stored a good key, but a bad env var wins
    // over it. Success must NOT be reported — the on-ramp would otherwise rerun
    // `on` with the same bad credential.
    await withHome("env-override", async (home) => {
      await persistApiKeyToKeychain(home, VALID_KEY);
      process.env.FIREWORKS_API_KEY = REJECTED_KEY; // env wins → verify rejects
      try {
        assert.equal(await signInSucceeded(home), false);
      } finally {
        delete process.env.FIREWORKS_API_KEY;
      }
    });
  });

  it("true on a network blip (a rejection it is not)", async () => {
    await withHome("network", async (home) => {
      await persistApiKeyToKeychain(home, VALID_KEY);
      const real = process.env.NEXUS_GATEWAY_URL;
      process.env.NEXUS_GATEWAY_URL = "http://127.0.0.1:1"; // unreachable
      try {
        assert.equal(await signInSucceeded(home), true); // lenient, not a rejection
      } finally {
        process.env.NEXUS_GATEWAY_URL = real;
      }
    });
  });
});
