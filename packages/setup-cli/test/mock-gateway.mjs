import { createServer } from "node:http";
import process from "node:process";

// Standalone test double for the gateway's GET /verifyApiKey, run as its OWN
// process by test/global-setup.mjs. It must be a separate process (not an
// in-test-process server) because several specs drive the CLI with
// `spawnSync`, which blocks the test process's event loop — an in-process
// server could not answer the child's verify request and the child would hang.
const server = createServer((req, res) => {
  if (req.url === "/verifyApiKey") {
    res.writeHead(200, {
      "x-fireworks-developer-email": "test@example.com",
      "x-fireworks-account-id": "acct-test",
    });
    res.end();
    return;
  }
  if (/^\/v1\/accounts\/[^/]+\/featureFlags$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ featureFlags: [] }));
    return;
  }
  // Provider Key bindings — only for keys marked "providerkeys", so specs
  // can choose the Connected and Not-enabled account states per test key.
  if (/^\/v1\/accounts\/[^/]+\/providerKeyBindings$/.test(req.url ?? "")) {
    const auth = req.headers.authorization ?? "";
    if (auth.includes("providerkeys-not-enabled")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 9, message: "provider keys are not enabled for account acct-test" }));
      return;
    }
    if (auth.includes("providerkeys")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        providerKeyBindings: [{
          name: "accounts/acct-test/providerKeyBindings/anthropic",
          providerType: "PROVIDER_TYPE_ANTHROPIC",
          providerKey: "accounts/acct-test/providerKeys/test-key",
          keyHint: "sk-ant-••••2kAA",
          state: "STATE_CONNECTED",
        }],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }
  // Serverless catalog (flat format) — only for keys marked "cataloged", so
  // specs can choose between the online path (catalog registers) and the
  // default offline path (404 below → catalogUnavailable) per test key.
  // Check v2 first because its marker also contains "cataloged".
  if (req.url?.startsWith("/v1/serverless/models") && req.headers.authorization?.includes("cataloged")) {
    const auth = req.headers.authorization ?? "";
    const data = auth.includes("cataloged_v2")
      ? [
        {
          id: "accounts/fireworks/models/glm-5p2",
          display_name: "GLM 5.2",
          serverless_mode: "standard",
          context_length: 1_048_576,
          supports_tools: true,
          aliases: ["accounts/fireworks/routers/glm-latest"],
        },
        {
          id: "accounts/fireworks/models/kimi-k3",
          display_name: "Kimi K3",
          serverless_mode: "standard",
          context_length: 1_048_576,
          supports_tools: true,
          aliases: ["accounts/fireworks/routers/kimi-latest"],
        },
      ]
      : [
        {
          id: "accounts/fireworks/models/deepseek-v4-flash",
          display_name: "DeepSeek V4 Flash",
          serverless_mode: "standard",
          context_length: 1_048_576,
          supports_tools: true,
        },
        {
          id: "accounts/fireworks/models/kimi-k3",
          display_name: "Kimi K3",
          serverless_mode: "standard",
          context_length: 1_048_576,
          supports_tools: true,
          aliases: ["accounts/fireworks/routers/kimi-latest"],
        },
      ];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`URL=http://127.0.0.1:${server.address().port}\n`);
});
