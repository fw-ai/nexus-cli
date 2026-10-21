import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

import {
  durableInstallContext,
  runPostinstallFinalize,
} from "../../lib/system/postinstall-finalize.mjs";

describe("postinstall finalize bootstrap", () => {
  it("derives HOME only from the durable curl-installer layout", () => {
    assert.deepEqual(
      durableInstallContext("/home/alice/.nexus/cli/packages/setup-cli"),
      {
        home: "/home/alice",
        installDir: "/home/alice/.nexus/cli",
      },
    );
    assert.equal(
      durableInstallContext("/work/fireconnect-internal/packages/setup-cli"),
      null,
    );
    assert.equal(
      durableInstallContext("/usr/local/lib/node_modules/@nexus/cli"),
      null,
    );
  });

  it("runs the new finalizer in the durable install and passes its package root", async () => {
    const calls = [];
    const setupDir = path.resolve("/home/alice/.nexus/cli/packages/setup-cli");

    assert.equal(await runPostinstallFinalize({
      setupDir,
      finalize: async (...args) => calls.push(args),
    }), true);
    assert.deepEqual(calls, [[
      "/home/alice",
      "/home/alice/.nexus/cli",
    ]]);
  });

  it("does nothing outside the durable install", async () => {
    let called = false;
    assert.equal(await runPostinstallFinalize({
      setupDir: "/work/fireconnect-internal/packages/setup-cli",
      finalize: async () => {
        called = true;
      },
    }), false);
    assert.equal(called, false);
  });

  it("skips when the current installer will finalize explicitly", async () => {
    const previous = process.env.NEXUS_SKIP_POSTINSTALL_FINALIZE;
    process.env.NEXUS_SKIP_POSTINSTALL_FINALIZE = "1";
    try {
      let called = false;
      assert.equal(await runPostinstallFinalize({
        setupDir: "/home/alice/.nexus/cli/packages/setup-cli",
        finalize: async () => {
          called = true;
        },
      }), false);
      assert.equal(called, false);
    } finally {
      if (previous === undefined) {
        delete process.env.NEXUS_SKIP_POSTINSTALL_FINALIZE;
      } else {
        process.env.NEXUS_SKIP_POSTINSTALL_FINALIZE = previous;
      }
    }
  });

  it("fails npm install when postflight cannot complete", async () => {
    await assert.rejects(
      runPostinstallFinalize({
        setupDir: "/home/alice/.nexus/cli/packages/setup-cli",
        finalize: async () => {
          throw new Error("migration failed");
        },
      }),
      /migration failed/,
    );
  });
});
