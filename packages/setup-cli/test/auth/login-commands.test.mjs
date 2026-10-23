import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { runCli, seedKeychainConfig, withTempHome } from "../helpers.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { pbDecode, pbStringAt } from "../../lib/auth/grpc-web.mjs";
import { runInteractiveSignIn } from "../../lib/auth/login/flows.mjs";
import { installShellEnvHook } from "../../lib/io/shell-env-hook.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_CODEX_ANTHROPIC_HOOK = [
  "# >>> fireconnect >>>",
  'export ANTHROPIC_API_KEY="$(fireconnect key export --stored-only --anthropic 2>/dev/null)"',
  "# <<< fireconnect <<<",
  "",
].join("\n");
const CLI = path.join(__dirname, "../../bin/nexus.mjs");

const VALID_KEY = "fw_login_test_key_000000000000000";
const REJECTED_KEY = "fw_login_rejected_key_00000000000";
const EMAIL = "dev@example.com";
const ACCOUNT = "acct-test";

/** Mock of the gateway's GET /verifyApiKey: identity headers on 200, 401 otherwise. */
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
        "x-fireworks-account-id": ACCOUNT,
        "x-fireworks-developer-email": EMAIL,
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

/**
 * Mock of the control plane's gRPC-web surface, for logout's DeleteApiKey.
 * Captures auth header + decoded request fields; answers with the given
 * grpc-status in the trailers frame.
 */
function startMockGrpcGateway({ status = 0, detail = "" } = {}) {
  /** @type {{ method: string, apiKey: string, parent: string, keyId: string }[]} */
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const request = pbDecode(body.subarray(5)); // skip the 5-byte frame header
      calls.push({
        method: req.url?.split("/").at(-1) ?? "",
        apiKey: String(req.headers["x-api-key"] ?? ""),
        parent: pbStringAt(request, 1),
        keyId: pbStringAt(request, 2),
      });
      const trailer = Buffer.from(`grpc-status:${status}\r\ngrpc-message:${detail}\r\n`);
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(Buffer.concat([
        Buffer.from([0x00, 0, 0, 0, 0]), // empty message frame (Empty)
        Buffer.from([0x80]),
        (() => { const len = Buffer.alloc(4); len.writeUInt32BE(trailer.length); return len; })(),
        trailer,
      ]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/web/gateway.Gateway` });
    });
  });
}

const MINTED_STATE = {
  keyId: "key-123",
  userName: "accounts/acct-test/users/u-1",
  displayName: "fireconnect-testhost",
};

async function seedMintedState(home) {
  await mkdir(path.join(home, ".nexus"), { recursive: true });
  await writeFile(path.join(home, ".nexus", "minted-key.json"), JSON.stringify(MINTED_STATE));
}

/** Like helpers.runCli but with a writable stdin (for --with-token). */
function runCliWithStdin(args, { home, env = {}, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        ...env,
        HOME: home,
        NEXUS_SECRET_STORE: "memory",
        NEXUS_TEST: "1",
        FIREWORKS_API_KEY: env.FIREWORKS_API_KEY ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    child.stdin.end(input);
  });
}

describe("fireconnect login / logout", () => {
  let gateway;
  let gatewayEnv;

  before(async () => {
    gateway = await startMockGateway();
    gatewayEnv = { NEXUS_GATEWAY_URL: gateway.url };
  });

  after(() => {
    gateway.server.close();
  });

  it("login --with-token validates, stores, and confirms identity", async () => {
    await withTempHome("login-with-token-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      const result = await runCliWithStdin(["login", "--with-token"], {
        home,
        env: gatewayEnv,
        input: `${VALID_KEY}\n`,
      });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));

      const exported = await runCli(["key", "export"], { home });
      assert.equal(exported.code, 0);
      assert.equal(exported.stdout.trim(), VALID_KEY);
    });
  });

  it("login --with-token rejects a wrong-shaped key without storing it", async () => {
    await withTempHome("login-token-shape-", async (home) => {
      const result = await runCliWithStdin(["login", "--with-token"], {
        home,
        env: gatewayEnv,
        input: "sk-not-a-fireworks-key\n",
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /doesn't look like a Fireworks key/);
      assert.doesNotMatch(result.stderr, /Error:/);

      const exported = await runCli(["key", "export"], { home });
      assert.notEqual(exported.code, 0);
    });
  });

  it("login --with-token surfaces an API-rejected key without storing it", async () => {
    await withTempHome("login-token-rejected-", async (home) => {
      const result = await runCliWithStdin(["login", "--with-token"], {
        home,
        env: gatewayEnv,
        input: `${REJECTED_KEY}\n`,
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /That key didn't work/);
      assert.doesNotMatch(result.stderr, /Error:/);

      const exported = await runCli(["key", "export"], { home });
      assert.notEqual(exported.code, 0);
    });
  });

  it("login --api-key signs in non-interactively", async () => {
    await withTempHome("login-flag-key-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      const result = await runCli(["login", "--api-key", VALID_KEY], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));

      const exported = await runCli(["key", "export"], { home });
      assert.equal(exported.stdout.trim(), VALID_KEY);
    });
  });

  it("login refuses to store a key while FIREWORKS_API_KEY is set", async () => {
    await withTempHome("login-env-conflict-", async (home) => {
      const result = await runCli(["login", "--api-key", VALID_KEY], {
        home,
        env: {
          FIREWORKS_API_KEY: VALID_KEY,
          // Conflict detection happens before verification.
          NEXUS_GATEWAY_URL: "http://127.0.0.1:1",
        },
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /FIREWORKS_API_KEY is already set/);
      assert.match(result.stderr, /unset FIREWORKS_API_KEY/);
      await assert.rejects(access(path.join(home, ".nexus", ".secret-memory")));
    });
  });

  it("interactive sign-in flows reject an environment credential before prompting", async () => {
    await withTempHome("login-interactive-env-conflict-", async (home) => {
      const previous = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = VALID_KEY;
      try {
        await assert.rejects(
          runInteractiveSignIn(home, { method: "paste" }),
          /FIREWORKS_API_KEY is already set/,
        );
        await assert.rejects(access(path.join(home, ".nexus", ".secret-memory")));
      } finally {
        if (previous === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = previous;
        }
      }
    });
  });

  it("login verifies and uses FIREWORKS_API_KEY without storing it", async () => {
    await withTempHome("login-env-only-", async (home) => {
      const result = await runCli(["login"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Already signed in as ${EMAIL}`));
      assert.match(result.stdout, /from FIREWORKS_API_KEY/);
      assert.match(result.stdout, /update FIREWORKS_API_KEY/);
      assert.match(result.stdout, /unset FIREWORKS_API_KEY/);
      await assert.rejects(access(path.join(home, ".nexus", ".secret-memory")));
    });
  });

  it("login with FIREWORKS_API_KEY and a fireconnect shell hook points at unset+login", async () => {
    await withTempHome("login-env-hook-", async (home) => {
      process.env.SHELL = "/bin/zsh";
      await installShellEnvHook(home);
      const result = await runCli(["login"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /shell hook exports this from the keychain/);
      assert.match(result.stdout, /unset FIREWORKS_API_KEY.*nexus login/);
      assert.doesNotMatch(result.stdout, /update FIREWORKS_API_KEY wherever you export it/);
    });
  });

  it("login with FIREWORKS_API_KEY and an Anthropic-only shell hook does not claim FireConnect exports it", async () => {
    await withTempHome("login-env-anthropic-hook-", async (home) => {
      process.env.SHELL = "/bin/zsh";
      await writeFile(path.join(home, ".zshrc"), LEGACY_CODEX_ANTHROPIC_HOOK);
      const result = await runCli(["login"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /shell hook exports this from the keychain/);
      assert.match(result.stdout, /update FIREWORKS_API_KEY wherever you export it/);
    });
  });

  it("login re-points the key baked into Claude's Fireworks settings", async () => {
    await withTempHome("login-router-refresh-", async (home) => {
      // A router-mode settings file from before this sign-in: stale key,
      // plus lines that must survive.
      const settingsPath = path.join(home, ".claude", "settings.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
          ANTHROPIC_MODEL: "accounts/fireworks/routers/firerouter[1m]",
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_stale_key_000000000000000000\nx-routing-preference: 3",
          ANTHROPIC_AUTH_TOKEN: "sk-ant-keep",
        },
      }));

      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });

      const result = await runCli(["login", "--api-key", VALID_KEY], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Fireworks settings/);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(
        settings.env.ANTHROPIC_CUSTOM_HEADERS,
        `X-Fireworks-Api-Key: ${VALID_KEY}\nx-routing-preference: 3`,
      );
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-ant-keep");
    });
  });

  async function seedStaleClaudeSettings(home) {
    const settingsPath = path.join(home, ".claude", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
        ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_stale_key_000000000000000000",
      },
    }));
    await writeGlobalConfig(home, {
      harnesses: { claude: { enabled: true, provider: "fireworks" } },
    });
    return settingsPath;
  }

  it("login with a rotated FIREWORKS_API_KEY re-points Claude's baked key", async () => {
    await withTempHome("login-env-rotate-", async (home) => {
      const settingsPath = await seedStaleClaudeSettings(home);

      const result = await runCli(["login"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Already signed in/);
      assert.match(result.stdout, /Updated Claude Code's Fireworks settings/);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, `X-Fireworks-Api-Key: ${VALID_KEY}`);
      await assert.rejects(access(path.join(home, ".nexus", ".secret-memory")));

      const again = await runCli(["login"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.doesNotMatch(again.stdout, /Updated Claude Code/);
    });
  });

  it("login with a rotated stored key re-points Claude's baked key", async () => {
    await withTempHome("login-stored-rotate-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const settingsPath = await seedStaleClaudeSettings(home);

      const result = await runCli(["login"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Updated Claude Code's Fireworks settings/);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, `X-Fireworks-Api-Key: ${VALID_KEY}`);
    });
  });

  it("login leaves baked keys alone when the active key can't be verified", async () => {
    await withTempHome("login-unverified-no-sync-", async (home) => {
      const settingsPath = await seedStaleClaudeSettings(home);

      const result = await runCli(["login"], {
        home,
        env: { NEXUS_GATEWAY_URL: "http://127.0.0.1:1", FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /couldn't verify/);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(
        settings.env.ANTHROPIC_CUSTOM_HEADERS,
        "X-Fireworks-Api-Key: fw_stale_key_000000000000000000",
      );
    });
  });

  it("login when already signed in reports identity and rotation hints", async () => {
    await withTempHome("login-already-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);

      const result = await runCli(["login"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Already signed in as ${EMAIL}`));
      assert.match(result.stdout, /--api-key/);
    });
  });

  it("login --account is an explicit re-auth: it runs even when already signed in", async () => {
    await withTempHome("login-account-signedin-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);
      const grpc = await startMockGrpcGateway({ status: 7 });
      try {
        const result = await runCli(["login", "--account", "bogus"], {
          home,
          env: { ...gatewayEnv, NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        // It attempted the SSO flow (and failed on the bogus account) rather
        // than short-circuiting on the stored key.
        assert.doesNotMatch(result.stdout, /Already signed in/);
        assert.match(result.stderr, /Couldn't find SSO sign-in configuration/);
      } finally {
        grpc.server.close();
      }
    });
  });

  it("login without a TTY points at --with-token instead of hanging", async () => {
    await withTempHome("login-no-tty-", async (home) => {
      const result = await runCli(["login"], { home, env: gatewayEnv });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--with-token/);
      assert.doesNotMatch(result.stderr, /Error:/);
    });
  });

  it("logout clears stored credentials and confirms", async () => {
    await withTempHome("logout-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);

      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Logged out/);

      const exported = await runCli(["key", "export"], { home });
      assert.notEqual(exported.code, 0);

      const check = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(check.code, 1);
    });
  });

  it("logout clears provider keys even without a stored Fireworks key", async () => {
    await withTempHome("logout-provider-only-", async (home) => {
      await writeGlobalConfig(home, {
        anthropicApiKey: "sk-ant-example-logout-0000",
        openaiApiKey: "sk-example-logout-0000",
      });
      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Logged out/);
      const config = await readGlobalConfig(home);
      assert.equal(config.anthropicApiKey, "");
      assert.equal(config.openaiApiKey, "");
    });
  });

  it("logout also clears saved Anthropic and OpenAI provider keys", async () => {
    await withTempHome("logout-provider-keys-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      await writeGlobalConfig(home, {
        anthropicApiKey: "sk-ant-example-logout-0000",
        openaiApiKey: "sk-example-logout-0000",
      });

      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Logged out/);

      const config = await readGlobalConfig(home);
      assert.equal(config.anthropicApiKey, "");
      assert.equal(config.openaiApiKey, "");
    });
  });

  it("configure --unset openai-api-key clears only the saved OpenAI key and leaves harness files it has no key in alone", async () => {
    await withTempHome("logout-openai-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      await writeGlobalConfig(home, {
        openaiApiKey: "sk-example-0000",
        harnesses: { opencode: { enabled: true, provider: "fireworks" }, cursor: { enabled: true, provider: "fireworks" } },
      });

      const result = await runCli(["configure", "--unset", "openai-api-key"], { home, env: { OPENAI_API_KEY: "" } });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Removed the saved OpenAI key/);
      assert.doesNotMatch(result.stdout, /Removed the saved OpenAI key from|Couldn't update/);
      assert.equal((await readGlobalConfig(home)).openaiApiKey, "");

      const fireworks = await runCli(["key", "export"], { home });
      assert.equal(fireworks.code, 0, fireworks.stderr);
      assert.equal(fireworks.stdout, VALID_KEY);
    });
  });

  it("configure --unset openai-api-key still finishes when a harness's settings can't be read, and says how to fix it", async () => {
    await withTempHome("logout-openai-bad-json-", async (home) => {
      await writeGlobalConfig(home, {
        openaiApiKey: "sk-example-0000",
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      const configPath = path.join(home, ".config/opencode/opencode.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, "{ not json");

      const result = await runCli(["configure", "--unset", "openai-api-key"], { home, env: { OPENAI_API_KEY: "" } });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Removed the saved OpenAI key\./);
      assert.match(result.stdout, /Couldn't update OpenCode's settings\. Run nexus opencode off/);
      assert.equal(await readFile(configPath, "utf8"), "{ not json");
    });
  });

  it("configure --unset anthropic-api-key leaves an env-reference setting alone", async () => {
    await withTempHome("logout-anthropic-ref-", async (home) => {
      await writeGlobalConfig(home, { anthropicApiKey: "{env:ANTHROPIC_API_KEY}" });
      const result = await runCli(["configure", "--unset", "anthropic-api-key"], { home, env: { ANTHROPIC_API_KEY: "" } });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /No saved Anthropic key to remove/);
      assert.equal((await readGlobalConfig(home)).anthropicApiKey, "{env:ANTHROPIC_API_KEY}");
    });
  });

  it("logout --revoke deletes the key this machine minted, then clears local state", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-revoke-", async (home) => {
        // Store first, then record the mint — the browser flow's order
        // (storing a key clears any previous machine's minted-key record).
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.match(result.stdout, /Revoked .*fireconnect-testhost.* server-side/);

        assert.equal(grpc.calls.length, 1);
        assert.equal(grpc.calls[0].method, "DeleteApiKey");
        assert.equal(grpc.calls[0].apiKey, VALID_KEY, "auth must be x-api-key with the stored key");
        assert.equal(grpc.calls[0].parent, MINTED_STATE.userName);
        assert.equal(grpc.calls[0].keyId, MINTED_STATE.keyId);

        await assert.rejects(access(path.join(home, ".nexus", "minted-key.json")));
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout --revoke authenticates with the stored minted key, not a stray env key", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-revoke-env-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        // A different key exported in the shell must not authenticate the
        // deletion of the minted key — that would target the wrong principal.
        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url, FIREWORKS_API_KEY: REJECTED_KEY },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.equal(grpc.calls.length, 1);
        assert.equal(grpc.calls[0].apiKey, VALID_KEY, "must authenticate with the stored minted key, not FIREWORKS_API_KEY");
        assert.equal(grpc.calls[0].keyId, MINTED_STATE.keyId);
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout without a TTY or --revoke leaves the minted key alone and says so", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-keep-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        const result = await runCli(["logout"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.match(result.stdout, /Left .*fireconnect-testhost.* active/);
        assert.match(result.stdout, /api-keys/);
        assert.equal(grpc.calls.length, 0, "must not revoke without consent");
      });
    } finally {
      grpc.server.close();
    }
  });

  it("storing a different key invalidates the minted-key record", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-stale-mint-", async (home) => {
        // Browser sign-in minted a key on this machine…
        await seedMintedState(home);
        // …then the user stored a different key (paste / --api-key / key set).
        await seedKeychainConfig(home, VALID_KEY);

        // logout must not describe or try to revoke the old minted key on
        // behalf of a credential it no longer holds.
        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.doesNotMatch(result.stdout, /fireconnect-testhost/);
        assert.equal(grpc.calls.length, 0, "no revocation for a key another credential minted");
        await assert.rejects(access(path.join(home, ".nexus", "minted-key.json")));
      });
    } finally {
      grpc.server.close();
    }
  });

  it("re-storing the same minted key keeps the revoke record", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-same-key-mint-", async (home) => {
        // Browser sign-in minted VALID_KEY and recorded the mint.
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        // An idempotent re-store of the SAME key (config repair, a repeated
        // sign-in) must NOT wipe minted-key.json — the key is still the one
        // this machine minted and should stay revocable.
        await seedKeychainConfig(home, VALID_KEY);
        await assert.doesNotReject(access(path.join(home, ".nexus", "minted-key.json")));

        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Revoked .*fireconnect-testhost.* server-side/);
        assert.equal(grpc.calls.length, 1);
        assert.equal(grpc.calls[0].keyId, MINTED_STATE.keyId);
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout still completes when revocation is refused, and says so", async () => {
    const grpc = await startMockGrpcGateway({ status: 7, detail: "permission denied" });
    try {
      await withTempHome("logout-revoke-denied-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.match(result.stdout, /Couldn't revoke/);
        assert.match(result.stdout, /permission denied/);
        assert.match(result.stdout, /api-keys/); // points at the console to finish the job

        const check = await runCli(["status"], { home, env: gatewayEnv });
        assert.equal(check.code, 1); // local credentials are gone regardless
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout with nothing stored says so and exits 0", async () => {
    await withTempHome("logout-none-", async (home) => {
      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Not signed in/);
    });
  });

  it("logout notes a lingering FIREWORKS_API_KEY env var", async () => {
    await withTempHome("logout-env-note-", async (home) => {
      const result = await runCli(["logout"], { home, env: { FIREWORKS_API_KEY: VALID_KEY } });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /FIREWORKS_API_KEY is still set/);
    });
  });

  // promptSignInMethod is TTY-only in real use; drive it through a subprocess
  // with piped stdin (same pattern as read-secret.test.mjs).
  function runMethodPrompt(input) {
    const loginPath = path.join(__dirname, "../../lib/cli/commands/login.mjs");
    const script = `
      import { promptSignInMethod } from ${JSON.stringify(loginPath)};
      const method = await promptSignInMethod();
      process.stdout.write("RESULT:" + JSON.stringify(method));
    `;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  function parseMethod(stdout) {
    const marker = stdout.lastIndexOf("RESULT:");
    assert.notEqual(marker, -1, stdout);
    return JSON.parse(stdout.slice(marker + "RESULT:".length));
  }

  describe("promptSignInMethod", () => {
    it("offers create-a-key and paste, defaulting to create (browser) on Enter", async () => {
      const result = await runMethodPrompt("\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /needs a Fireworks API key for this machine/);
      assert.match(result.stdout, /nexus logout/);
      assert.match(result.stdout, /Create one for me/);
      assert.match(result.stdout, /already have a key/);
      assert.equal(parseMethod(result.stdout), "browser");
    });

    it("returns paste for choice 2", async () => {
      const result = await runMethodPrompt("2\n");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(parseMethod(result.stdout), "paste");
    });

    it("returns sso for choice 3", async () => {
      const result = await runMethodPrompt("3\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /custom SSO/);
      assert.equal(parseMethod(result.stdout), "sso");
    });

    it("re-asks on invalid input, and q cancels", async () => {
      const result = await runMethodPrompt("banana\nq\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Enter 1, 2 or 3/);
      assert.equal(parseMethod(result.stdout), null);
    });
  });

  describe("promptAccountId", () => {
    // Same TTY-only subprocess pattern as the other prompts.
    function runAccountIdPrompt(remembered, input) {
      const loginPath = path.join(__dirname, "../../lib/cli/commands/login.mjs");
      const script = `
        import { promptAccountId } from ${JSON.stringify(loginPath)};
        const id = await promptAccountId(${JSON.stringify(remembered)});
        process.stdout.write("RESULT:" + JSON.stringify(id));
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      });
    }

    it("returns the typed account id", async () => {
      const result = await runAccountIdPrompt("", "my-company\n");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(parseMethod(result.stdout), "my-company");
    });

    it("Enter takes the remembered id; without one it re-asks", async () => {
      const remembered = await runAccountIdPrompt("uber", "\n");
      assert.equal(parseMethod(remembered.stdout), "uber");

      const reasked = await runAccountIdPrompt("", "\nacme\n");
      assert.match(reasked.stdout, /Enter your account ID/);
      assert.equal(parseMethod(reasked.stdout), "acme");
    });

    it("q and EOF cancel", async () => {
      const cancelled = await runAccountIdPrompt("uber", "q\n");
      assert.equal(parseMethod(cancelled.stdout), null);
      const eof = await runAccountIdPrompt("", "");
      assert.equal(parseMethod(eof.stdout), null);
    });
  });

  describe("promptAccountChoice", () => {
    // When browser sign-in resolves to several accounts, the user must pick
    // which one the key belongs to — same TTY-only subprocess pattern as
    // promptSignInMethod.
    function runAccountPrompt(accountNames, input) {
      const loginPath = path.join(__dirname, "../../lib/cli/commands/login.mjs");
      const script = `
        import { promptAccountChoice } from ${JSON.stringify(loginPath)};
        const idx = await promptAccountChoice(${JSON.stringify(accountNames)});
        process.stdout.write("RESULT:" + JSON.stringify(idx));
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      });
    }

    const accounts = ["accounts/acme", "accounts/personal"];

    it("lists the accounts and defaults to the first on Enter", async () => {
      const result = await runAccountPrompt(accounts, "\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /more than one Fireworks account/);
      assert.match(result.stdout, /acme/);
      assert.match(result.stdout, /personal/);
      assert.equal(parseMethod(result.stdout), 0);
    });

    it("returns the chosen index for a number", async () => {
      const result = await runAccountPrompt(accounts, "2\n");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(parseMethod(result.stdout), 1);
    });

    it("re-asks on invalid input, and q cancels", async () => {
      const result = await runAccountPrompt(accounts, "banana\nq\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Enter 1 to 2, or q to cancel/);
      assert.equal(parseMethod(result.stdout), null);
    });
  });

  describe("promptYesNo", () => {
    function runYesNo(input, runYesNoOptions = "{}") {
      const loginPath = path.join(__dirname, "../../lib/cli/commands/login.mjs");
      const script = `
        import { promptYesNo } from ${JSON.stringify(loginPath)};
        const answer = await promptYesNo("Proceed?", ${runYesNoOptions});
        process.stdout.write("RESULT:" + JSON.stringify(answer));
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
        child.stdin.end(input);
      });
    }

    it("Enter means yes", async () => {
      const result = await runYesNo("\n");
      assert.equal(parseMethod(result.stdout), true);
    });

    it("n means no; invalid input re-asks; EOF means no", async () => {
      assert.equal(parseMethod((await runYesNo("n\n")).stdout), false);
      const reasked = await runYesNo("maybe\nyes\n");
      assert.match(reasked.stdout, /Enter y or n/);
      assert.equal(parseMethod(reasked.stdout), true);
      assert.equal(parseMethod((await runYesNo("")).stdout), false);
    });

    it("defaultYes:false flips the prompt and the Enter default (rotation prompt)", async () => {
      const entered = await runYesNo("\n", '{ "defaultYes": false }');
      assert.match(entered.stdout, /\[y\/N\]/);
      assert.equal(parseMethod(entered.stdout), false);
      assert.equal(parseMethod((await runYesNo("y\n", '{ "defaultYes": false }')).stdout), true);
    });
  });

  it("help lists login and logout", async () => {
    await withTempHome("login-help-", async (home) => {
      const help = await runCli(["help"], { home });
      assert.match(help.stdout, /login\s+Sign in to Fireworks/);
      assert.match(help.stdout, /logout\s+Clear stored credentials/);

      const topic = await runCli(["help", "login"], { home });
      assert.match(topic.stdout, /--with-token/);
      assert.match(topic.stdout, /--account/);
      assert.match(topic.stdout, /--force/);
      assert.match(topic.stdout, /--paste/);
    });
  });
});
