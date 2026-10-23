import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getProviderKeysStatus,
  parseProviderKeyBindings,
  providerKeyStatusLine,
} from "../../lib/keys/provider-keys-status.mjs";

const verifyOk = async () => ({
  ok: true,
  reason: "",
  email: "test@example.com",
  accountId: "acct-test",
  status: 200,
  detail: "",
});

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

describe("provider keys status", () => {
  it("parses connected and missing bindings", () => {
    const providers = parseProviderKeyBindings({
      providerKeyBindings: [{
        providerType: "PROVIDER_TYPE_ANTHROPIC",
        keyHint: "sk-ant-••••2kAA",
        state: "STATE_CONNECTED",
      }],
    });
    assert.deepEqual(providers.anthropic, { state: "connected", keyHint: "sk-ant-••••2kAA" });
    assert.deepEqual(providers.openai, { state: "not-connected", keyHint: "" });
  });

  it("re-masks an unmasked server keyHint before display", () => {
    const fullKey = "sk-ant-api03-examplefullkeyvalue-2kAA";
    const providers = parseProviderKeyBindings({
      providerKeyBindings: [{
        providerType: "anthropic",
        keyHint: fullKey,
        state: "connected",
      }],
    });
    assert.equal(providers.anthropic.keyHint, "sk-ant-••••2kAA");
    const line = providerKeyStatusLine(
      { outcome: "ok", providers },
      "anthropic",
    );
    assert.ok(!line.includes(fullKey));
    assert.ok(line.includes("sk-ant-••••2kAA"));
  });

  it("re-masks a full key that merely contains a mask character", () => {
    const providers = parseProviderKeyBindings({
      providerKeyBindings: [{
        providerType: "anthropic",
        keyHint: "sk-ant-api03-example*fullkeyvalue-9zZZ",
        state: "connected",
      }],
    });
    assert.ok(!providers.anthropic.keyHint.includes("fullkeyvalue"));
    assert.ok(providers.anthropic.keyHint.includes("••••"));
  });

  it("re-masks short and prefix-less unmasked hints", () => {
    const providers = parseProviderKeyBindings({
      providerKeyBindings: [
        { providerType: "openai", keyHint: "shortkey", state: "connected" },
      ],
    });
    assert.equal(providers.openai.keyHint, "••••");
  });

  it("parses snake_case and numeric enum shapes", () => {
    const providers = parseProviderKeyBindings({
      provider_key_bindings: [{
        provider_type: 2,
        key_hint: "sk-proj-••••4b9x",
        state: "STATE_CONNECTING",
      }],
    });
    assert.deepEqual(providers.openai, { state: "connecting", keyHint: "sk-proj-••••4b9x" });
  });

  it("reads bindings with the verified account", async () => {
    const seen = [];
    const status = await getProviderKeysStatus({
      apiKey: "fw_test",
      gatewayUrl: "https://api.fireworks.ai",
      verify: verifyOk,
      fetchImpl: async (url, options) => {
        seen.push([url, options.headers.Authorization]);
        return jsonResponse(200, {
          providerKeyBindings: [{
            providerType: "PROVIDER_TYPE_OPENAI",
            keyHint: "sk-proj-••••4b9x",
            state: "STATE_CONNECTED",
          }],
        });
      },
    });
    assert.equal(status.outcome, "ok");
    assert.equal(seen[0][0], "https://api.fireworks.ai/v1/accounts/acct-test/providerKeyBindings");
    assert.equal(seen[0][1], "Bearer fw_test");
    assert.equal(providerKeyStatusLine(status, "openai"), "Connected (sk-proj-••••4b9x), covers every harness");
    assert.equal(providerKeyStatusLine(status, "anthropic"), "Not connected");
  });

  it("bounds the verify call with the same timeout as the bindings read", async () => {
    let seenOptions;
    const status = await getProviderKeysStatus({
      apiKey: "fw_test",
      gatewayUrl: "https://api.fireworks.ai",
      timeoutMs: 123,
      verify: async (key, options) => {
        seenOptions = options;
        return verifyOk();
      },
      fetchImpl: async () => jsonResponse(200, { providerKeyBindings: [] }),
    });
    assert.equal(status.outcome, "ok");
    assert.equal(seenOptions.timeoutMs, 123);
  });

  it("maps the not-enabled precondition to its own outcome", async () => {
    const status = await getProviderKeysStatus({
      apiKey: "fw_test",
      verify: verifyOk,
      fetchImpl: async () => jsonResponse(400, {
        code: 9,
        message: "provider keys are not enabled for account acct-test",
      }),
    });
    assert.equal(status.outcome, "not-enabled");
    assert.equal(providerKeyStatusLine(status, "anthropic"), "Not enabled on this account");
  });

  it("never throws on network or signed-out states", async () => {
    assert.equal((await getProviderKeysStatus({ apiKey: "", verify: verifyOk })).outcome, "no-key");

    const unavailable = await getProviderKeysStatus({
      apiKey: "fw_test",
      verify: verifyOk,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(unavailable.outcome, "unavailable");
    assert.equal(providerKeyStatusLine(unavailable, "openai"), "Couldn't check just now");

    const rejected = await getProviderKeysStatus({
      apiKey: "fw_test",
      verify: async () => ({ ok: false, reason: "rejected", email: "", accountId: "", status: 401, detail: "" }),
    });
    assert.equal(rejected.outcome, "rejected");
  });
});
