import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runFireconnect, withTempHome } from "../helpers.mjs";
import { USER_SETTINGS_RELATIVE_PATH } from "../../lib/harnesses/claude/core.mjs";

const VALID_KEY = "fw_on_validation_valid_0000000000";
const REJECTED_KEY = "fw_on_validation_rejected_0000000";

/** GET /verifyApiKey mock: 200 (+ identity) for VALID_KEY, 401 otherwise. */
function startMockGateway() {
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
        "x-fireworks-account-id": "acct-test",
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

async function fileExists(filePath) {
  return access(filePath).then(() => true).catch(() => false);
}

describe("<harness> on --api-key validation", () => {
  it("rejects --api-key when FIREWORKS_API_KEY is already set", async () => {
    await withTempHome("on-validate-env-conflict-", async (home) => {
      const result = await runFireconnect(
        ["claude", "on", "--api-key", VALID_KEY],
        {
          HOME: home,
          FIREWORKS_API_KEY: VALID_KEY,
          // Conflict detection happens before verification.
          NEXUS_GATEWAY_URL: "http://127.0.0.1:1",
        },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /FIREWORKS_API_KEY is already set/);
      assert.match(result.stderr, /unset FIREWORKS_API_KEY/);
      assert.equal(await fileExists(path.join(home, ".nexus", ".secret-memory")), false);
      assert.equal(await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)), false);
    });
  });

  it("uses and stores an env-only key without requiring live verification", async () => {
    await withTempHome("on-validate-env-only-", async (home) => {
      const result = await runFireconnect(
        ["codex", "on"],
        {
          HOME: home,
          FIREWORKS_API_KEY: VALID_KEY,
          NEXUS_GATEWAY_URL: "http://127.0.0.1:1",
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await fileExists(path.join(home, ".nexus", ".secret-memory")), true);

      const config = JSON.parse(await readFile(path.join(home, ".nexus", "config.json"), "utf8"));
      assert.equal(config.apiKey, "{keychain:fireworks-api-key}");
      const codexConfig = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
      assert.match(codexConfig, new RegExp(`"x-fireworks-api-key" = "${VALID_KEY}"`));
      for (const shellConfig of [".bashrc", ".bash_profile", ".zshrc"]) {
        const filePath = path.join(home, shellConfig);
        if (await fileExists(filePath)) {
          assert.doesNotMatch(await readFile(filePath, "utf8"), /# >>> fireconnect >>>/);
        }
      }
    });
  });

  it("rejects a malformed env-only key without a network request", async () => {
    await withTempHome("on-validate-env-shape-", async (home) => {
      const result = await runFireconnect(
        ["claude", "on", "--non-interactive"],
        {
          HOME: home,
          FIREWORKS_API_KEY: "not-a-fireworks-key",
          NEXUS_GATEWAY_URL: "http://127.0.0.1:1",
        },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /doesn't look like a Fireworks key/i);
      assert.equal(await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)), false);
    });
  });

  it("rejects a malformed key on shape before any network call", async () => {
    await withTempHome("on-validate-shape-", async (home) => {
      const result = await runFireconnect(
        ["claude", "on", "--api-key", "not-a-fireworks-key"],
        // Point verify at an unreachable port to prove the shape check short-circuits.
        { HOME: home, NEXUS_GATEWAY_URL: "http://127.0.0.1:1" },
      );
      assert.notEqual(result.code, 0, "malformed --api-key must fail");
      assert.match(result.stderr, /doesn't look like a Fireworks key/i);
      assert.equal(
        await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)),
        false,
        "a rejected key must not be baked into the harness config",
      );
    });
  });

  it("rejects a well-shaped but unverifiable key (gateway 401)", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-reject-", async (home) => {
        const result = await runFireconnect(
          ["claude", "on", "--api-key", REJECTED_KEY],
          { HOME: home, NEXUS_GATEWAY_URL: url },
        );
        assert.notEqual(result.code, 0, "a gateway-rejected --api-key must fail");
        assert.match(result.stderr, /didn't work/i);
        assert.equal(
          await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)),
          false,
          "a rejected key must not be baked into the harness config",
        );
      });
    } finally {
      server.close();
    }
  });

  it("accepts a verified key and enables the harness", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-accept-", async (home) => {
        const result = await runFireconnect(
          ["claude", "on", "--api-key", VALID_KEY],
          { HOME: home, NEXUS_GATEWAY_URL: url },
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(
          await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)),
          true,
          "a verified key enables the harness",
        );
      });
    } finally {
      server.close();
    }
  });
});
