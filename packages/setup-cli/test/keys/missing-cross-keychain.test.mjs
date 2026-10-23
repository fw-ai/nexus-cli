import assert from "node:assert/strict";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it, beforeEach, afterEach } from "node:test";
import { itIfNpm, seedOnCommandCatalog } from "../helpers.mjs";

import {
  cliDependenciesMissingMessage,
  crossKeychainInstalled,
  dependencyInstalled,
  ensureCliDependencies,
  resolveSetupCliDir,
  runtimeDependencyNames,
  runtimeDepsInstalled,
} from "../../lib/system/ensure-cli-deps.mjs";
import {
  KEY_STORAGE_ENV,
  resetSecretStoreForTests,
} from "../../lib/keys/secret-store.mjs";

describe("ensure-cli-deps", () => {
  it("resolveSetupCliDir points at packages/setup-cli", () => {
    assert.equal(path.basename(resolveSetupCliDir()), "setup-cli");
    assert.ok(runtimeDepsInstalled());
  });

  it("tracks every package.json production dependency, including yaml", () => {
    const names = runtimeDependencyNames();
    assert.ok(names.includes("yaml"));
    assert.ok(names.includes("smol-toml"));
    assert.ok(names.includes("ansis"));
    assert.ok(names.includes("cross-keychain"));
  });
});

function fileBackendEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "cfg"),
    [KEY_STORAGE_ENV]: "file",
    KEYRING_FILE_MASTER_KEY: "a".repeat(64),
  };
  delete env.NEXUS_SECRET_STORE;
  delete env.FIREWORKS_API_KEY;
  return env;
}

describe("dep-less checkout configure", () => {
  let home;
  let setupDir;
  let savedHome;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    home = await mkdtemp(path.join(os.tmpdir(), "fc-fallback-"));
    process.env.HOME = home;
    resetSecretStoreForTests();

    setupDir = await mkdtemp(path.join(os.tmpdir(), "fc-setup-"));
    await cp(resolveSetupCliDir(), setupDir, { recursive: true });
    await rm(path.join(setupDir, "node_modules"), { recursive: true, force: true });
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
    await rm(setupDir, { recursive: true, force: true });
  });

  itIfNpm("ensureCliDependencies installs runtime deps from a dep-less checkout copy", () => {
    assert.equal(runtimeDepsInstalled(setupDir), false);
    assert.equal(ensureCliDependencies(setupDir), true);
    assert.equal(crossKeychainInstalled(setupDir), true);
    assert.equal(dependencyInstalled("ansis", setupDir), true);
  });

  itIfNpm("ensureCliDependencies repairs a partial install missing ansis", async () => {
    assert.equal(ensureCliDependencies(setupDir), true);
    await rm(path.join(setupDir, "node_modules", "ansis"), { recursive: true, force: true });
    assert.equal(dependencyInstalled("ansis", setupDir), false);
    assert.equal(crossKeychainInstalled(setupDir), true);
    assert.equal(ensureCliDependencies(setupDir), true);
    assert.equal(dependencyInstalled("ansis", setupDir), true);
  });

  itIfNpm("ensureCliDependencies repairs a partial install missing yaml", async () => {
    assert.equal(ensureCliDependencies(setupDir), true);
    await rm(path.join(setupDir, "node_modules", "yaml"), { recursive: true, force: true });
    assert.equal(dependencyInstalled("yaml", setupDir), false);
    assert.equal(runtimeDepsInstalled(setupDir), false);
    assert.equal(ensureCliDependencies(setupDir), true);
    assert.equal(dependencyInstalled("yaml", setupDir), true);
  });

  itIfNpm("harness on succeeds from a dep-less checkout (auto npm install)", async () => {
    const env = fileBackendEnv(home);
    // Placeholder keys 404 the mock gateway's catalog endpoint; seed the
    // empty cache so `on` takes the stale-cache path like other CLI specs.
    seedOnCommandCatalog(home, ["claude", "on"]);

    const res = spawnSync(
      process.execPath,
      [
        path.join(setupDir, "bin/nexus.mjs"),
        "--home", home,
        "claude", "on", "--skip-install-check",
        "--api-key", "fw_fallback_test_key",
      ],
      { env, encoding: "utf8", timeout: 120000 },
    );
    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    await assert.doesNotReject(access(path.join(home, "data/keyring/secrets.json")));
    assert.doesNotMatch(
      `${res.stdout}\n${res.stderr}`,
      /cross-keychain secret module could not be loaded/,
    );
  });

  it("exits with upgrade guidance when npm install is unavailable", async () => {
    await rm(path.join(setupDir, "package.json"));
    const env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "cfg"),
    };

    const res = spawnSync(
      process.execPath,
      [path.join(setupDir, "bin/nexus.mjs"), "help"],
      { env, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(res.status, 1, `${res.stderr}\n${res.stdout}`);
    assert.match(res.stderr, /nexus update/i);
    assert.match(res.stderr, new RegExp(cliDependenciesMissingMessage().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  itIfNpm("harness on falls back to builtin encrypted file when cross-keychain is missing", async () => {
    assert.equal(ensureCliDependencies(setupDir), true);
    // Keep package.json so the startup dependency guard does not auto-repair
    // the package. Removing the ESM entry point makes the runtime import fail,
    // which exercises Nexus's built-in encrypted-file fallback on every
    // OS, including macOS where a successfully reinstalled package would use
    // the native Keychain instead.
    await rm(
      path.join(setupDir, "node_modules", "cross-keychain", "dist", "index.js"),
      { force: true },
    );

    const env = fileBackendEnv(home);
    seedOnCommandCatalog(home, ["claude", "on"]);

    const res = spawnSync(
      process.execPath,
      [
        path.join(setupDir, "bin/nexus.mjs"),
        "--home", home,
        "claude", "on", "--skip-install-check",
        "--api-key", "fw_builtin_only_key",
      ],
      { env, encoding: "utf8", timeout: 120000 },
    );
    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    await assert.doesNotReject(access(path.join(home, "data/keyring/secrets.json")));
    assert.doesNotMatch(
      `${res.stdout}\n${res.stderr}`,
      /cross-keychain secret module could not be loaded/,
    );
  });
});
