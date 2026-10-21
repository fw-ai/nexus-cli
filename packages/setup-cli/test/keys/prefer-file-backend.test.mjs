import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  remoteSecretStorageDetail,
  shouldPreferFileBackendOnLinux,
  shouldSkipEnvKeyAutoPersist,
} from "../../lib/config/secret-storage-policy.mjs";
import { withLinuxSshEnv } from "../helpers.mjs";

describe("secret storage policy", () => {
  it("returns false when not on Linux", () => {
    if (process.platform === "linux") {
      return;
    }
    assert.equal(shouldPreferFileBackendOnLinux(), false);
  });

  it("returns true on Linux when SSH env markers are set", async () => {
    await withLinuxSshEnv((isLinux) => {
      if (!isLinux) {
        return;
      }
      assert.equal(shouldPreferFileBackendOnLinux(), true);
      assert.match(remoteSecretStorageDetail() ?? "", /SSH\/remote/i);
      assert.equal(shouldSkipEnvKeyAutoPersist(), true);
    });
  });

  it("returns false when NEXUS_KEY_STORAGE is explicitly set", async () => {
    await withLinuxSshEnv((isLinux) => {
      if (!isLinux) {
        return;
      }
      const prev = process.env.NEXUS_KEY_STORAGE;
      process.env.NEXUS_KEY_STORAGE = "keychain";
      try {
        assert.equal(shouldPreferFileBackendOnLinux(), false);
      } finally {
        if (prev === undefined) delete process.env.NEXUS_KEY_STORAGE;
        else process.env.NEXUS_KEY_STORAGE = prev;
      }
    });
  });
});
