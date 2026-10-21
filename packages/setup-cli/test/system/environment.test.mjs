import os from "node:os";
import process from "node:process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ENVIRONMENT_SCHEMA_VERSION,
  detectEnvironment,
  detectSecretStorage,
  isWsl,
} from "../../lib/system/environment.mjs";
import { withLinuxSshEnv } from "../helpers.mjs";

describe("environment detection", () => {
  it("detects a structured, current-platform environment", () => {
    const env = detectEnvironment({ home: "/tmp/whatever" });
    assert.equal(env.schemaVersion, ENVIRONMENT_SCHEMA_VERSION);
    assert.match(env.detectedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(env.os.platform, process.platform);
    assert.equal(env.os.arch, process.arch);
    assert.equal(env.node.version, process.versions.node);
    assert.ok(["macos", "windows", "wsl", "linux", "unknown"].includes(env.kind));
    assert.ok(typeof env.secretStorage.backend === "string" && env.secretStorage.backend.length > 0);
  });

  it("maps kind to the host platform", () => {
    const env = detectEnvironment();
    if (process.platform === "linux") {
      assert.ok(env.kind === "linux" || env.kind === "wsl");
      assert.equal(typeof env.os.wsl, "boolean");
    } else if (process.platform === "darwin") {
      assert.equal(env.kind, "macos");
    } else if (process.platform === "win32") {
      assert.equal(env.kind, "windows");
    }
  });

  it("isWsl returns a boolean", () => {
    assert.equal(typeof isWsl(), "boolean");
  });

  it("detectSecretStorage honors NEXUS_KEY_STORAGE=file", () => {
    const prev = process.env.NEXUS_KEY_STORAGE;
    process.env.NEXUS_KEY_STORAGE = "file";
    try {
      const s = detectSecretStorage();
      assert.equal(s.backend, "file");
      assert.equal(s.strong, true);
    } finally {
      if (prev === undefined) delete process.env.NEXUS_KEY_STORAGE;
      else process.env.NEXUS_KEY_STORAGE = prev;
    }
  });

  it("names a platform-appropriate secret backend without the override", () => {
    const prev = process.env.NEXUS_KEY_STORAGE;
    delete process.env.NEXUS_KEY_STORAGE;
    try {
      const s = detectSecretStorage();
      const expected = {
        darwin: "macos-keychain",
        win32: "windows-credential-manager",
      }[process.platform];
      if (expected) {
        assert.equal(s.backend, expected);
      } else {
        // linux: secret-service when libsecret is present, else the file fallback.
        assert.ok(["secret-service", "file"].includes(s.backend));
      }
    } finally {
      if (prev !== undefined) process.env.NEXUS_KEY_STORAGE = prev;
    }
  });

  it("prefers encrypted file on Linux SSH sessions", async () => {
    await withLinuxSshEnv((isLinux) => {
      if (!isLinux) {
        return;
      }
      const s = detectSecretStorage();
      assert.equal(s.backend, "file");
      assert.match(s.detail ?? "", /SSH\/remote/i);
    });
  });
});
