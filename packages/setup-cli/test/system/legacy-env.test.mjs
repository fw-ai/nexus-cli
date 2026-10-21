import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adoptLegacyEnv } from "../../lib/system/legacy-env.mjs";

describe("adoptLegacyEnv", () => {
  it("copies FIRECONNECT_* to NEXUS_* without overriding an explicit NEXUS_*", () => {
    const env = {
      FIRECONNECT_GATEWAY_URL: "http://legacy",
      FIRECONNECT_KEY_STORAGE: "file",
      NEXUS_KEY_STORAGE: "keychain",
      FIRECONNECT_EMPTY: "",
      OTHER: "x",
    };
    adoptLegacyEnv(env);
    assert.equal(env.NEXUS_GATEWAY_URL, "http://legacy");
    assert.equal(env.NEXUS_KEY_STORAGE, "keychain");
    assert.equal(env.NEXUS_EMPTY, "");
    assert.equal(env.NEXUS_OTHER, undefined);
  });
});
