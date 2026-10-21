import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Test assertions compare stable plain-text CLI output. Do not inherit a
// developer shell's FORCE_COLOR setting (common in IDE terminals), which would
// inject ANSI escape sequences even though spawned stdout is piped.
process.env.FORCE_COLOR = "0";
process.env.NO_COLOR = "1";

// Default every test process to the isolated secret store. Individual
// secret-backend specs explicitly unset these and force file/null storage.
process.env.NEXUS_TEST ??= "1";
process.env.NEXUS_SECRET_STORE ??= "memory";

// Point the persisted catalog cache at a throwaway dir for EVERY test process,
// not just the ones that import test/helpers.mjs. Catalog lookups lazy-load this
// file, so without it a spec that never touches the cache would read (and price
// from) the developer's own ~/.nexus snapshot.
process.env.NEXUS_CACHE_DIR ??= mkdtempSync(path.join(os.tmpdir(), "fc-cache-global-"));

// Preloaded via `--import` for every test process (see package.json `test`).
//
// `<harness> on --api-key` and `login` now strict-verify the key against the
// gateway's GET /verifyApiKey before storing it. Specs that spawn the real CLI
// with placeholder fw_ keys would otherwise make a live network call, so
// stand up a permissive local double (200 + identity headers for any key) and
// point the CLI at it via NEXUS_GATEWAY_URL.
//
// The double runs in a SEPARATE process (test/mock-gateway.mjs): some specs
// drive the CLI with `spawnSync`, which blocks this process's event loop, so an
// in-process server could not answer the child and it would hang.
//
// Specs that exercise verification directly (login/status/key) start their own
// mock and pass NEXUS_GATEWAY_URL per spawn, which overrides this default;
// the `if (!…)` guard also leaves any externally-set value untouched.
if (!process.env.NEXUS_GATEWAY_URL) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "mock-gateway.mjs");
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk;
      const match = buf.match(/^URL=(\S+)$/m);
      if (match) {
        child.stdout.off("data", onData);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`mock gateway exited early (code ${code})`)));
  });
  // Release the stdio pipe + child handle so they don't keep THIS process's
  // event loop alive (which would hang the test file after its tests finish).
  child.stdout.destroy();
  child.unref();
  process.env.NEXUS_GATEWAY_URL = url;
  process.env.NEXUS_GATEWAY_GRPC_WEB_URL = `${url}/web/gateway.Gateway`;
  // Don't leave the mock process running after the test process exits.
  process.on("exit", () => {
    try {
      child.kill();
    } catch {
      // best effort
    }
  });
}
