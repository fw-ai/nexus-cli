import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_BYOK_HEADER,
  anthropicKeyFromCustomHeaders,
  byokEnvFromHeaders,
  resolveAnthropicKey,
  buildClaudeCustomHeaders,
  firerouterStatusFromEnv,
  firerouterTagline,
  replaceFireworksKeyInCustomHeaders,
  stripFirerouterOwnedEnv,
  stripManagedCustomHeaderLines,
} from "../../lib/firerouter/core.mjs";
import { FIREWORKS_BASE_URL } from "../../lib/fireworks/model-id.mjs";
import { providerStatusFromEnv } from "../../lib/harnesses/claude/core.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
describe("firerouter-core", () => {
  it("describes bare firerouter, one-model routes, and listed routes as FireRouter serves them", () => {
    assert.equal(firerouterTagline("firerouter"), "Routes each user turn between open models and the closed models you have access to.");
    assert.equal(firerouterTagline("firerouter/astra"), "Routes each user turn between this closed model and Fireworks open models.");
    assert.equal(firerouterTagline("firerouter/opus"), "Routes each user turn between this closed model and Fireworks open models.");
    assert.equal(firerouterTagline("accounts/fireworks/routers/firerouter/claude-opus-5-5[1m]"), "Routes each user turn between this closed model and Fireworks open models.");
    assert.equal(firerouterTagline("firerouter/gpt-6.1-sol"), "Routes each user turn between this closed model and Fireworks open models.");
    assert.equal(firerouterTagline("firerouter/kimi-k3"), "Serves this model on every turn.");
    assert.equal(firerouterTagline("firerouter/auto"), "Routes each user turn across Fireworks open models.");
    assert.equal(firerouterTagline("firerouter/auto-instant"), "Routes each user turn across the fastest Fireworks open models.");
    assert.equal(
      firerouterTagline("firerouter/opus/glm-5p3"),
      "Routes each user turn across only the models listed in this route.",
    );
  });

  it("detects FireRouter mode from the `firerouter` model id, not base URL", () => {
    assert.equal(firerouterStatusFromEnv({ ANTHROPIC_MODEL: "firerouter" }), "firerouter");
    assert.equal(firerouterStatusFromEnv({ ANTHROPIC_MODEL: "accounts/fireworks/models/glm-5p2" }), "other");
    assert.equal(firerouterStatusFromEnv({}), "other");
  });

  it("does not infer router mode from stale headers on direct Fireworks URL", () => {
    const env = {
      ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
      ANTHROPIC_CUSTOM_HEADERS: "X-Stale-Fireworks-Key: fw_test",
    };
    assert.equal(firerouterStatusFromEnv(env), "other");
    assert.equal(providerStatusFromEnv(env), "fireworks");
  });

  it("builds Claude custom headers", () => {
    const headers = buildClaudeCustomHeaders({
      fireworksKey: "fw_test",
    });
    assert.equal(headers, "X-Fireworks-Api-Key: fw_test");
  });

  it("swaps the Fireworks key in custom headers, preserving other lines", () => {
    const current = "X-Fireworks-Api-Key: fw_old\nx-routing-preference: 3\nX-User-Header: keep-me";
    assert.equal(
      replaceFireworksKeyInCustomHeaders(current, "fw_new"),
      "X-Fireworks-Api-Key: fw_new\nx-routing-preference: 3\nX-User-Header: keep-me",
    );
  });

  it("stripManagedCustomHeaderLines removes only FireConnect-managed lines", () => {
    const value = [
      "X-Fireworks-Api-Key: fw_test",
      "x-anthropic-api-key: sk-ant",
      "x-routing-preference: 3",
      "User-Agent: fireconnect/0.7.0",
      "X-FireRouter-Harness: claude_code/old",
      "X-User-Trace: keep-me",
      "X-Team: platform",
    ].join("\n");
    assert.equal(stripManagedCustomHeaderLines(value), "X-User-Trace: keep-me\nX-Team: platform");
    // Nothing of ours → returns only the user lines unchanged.
    assert.equal(stripManagedCustomHeaderLines("X-User-Trace: keep-me"), "X-User-Trace: keep-me");
    // Only managed lines → empty, so callers can drop the field entirely.
    assert.equal(stripManagedCustomHeaderLines("X-Fireworks-Api-Key: fw_test"), "");
  });

  it("stripFirerouterOwnedEnv keeps user custom-header lines while dropping managed ones", () => {
    const { env, changed } = stripFirerouterOwnedEnv({
      ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
      ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test\nX-User-Trace: keep-me",
    });
    assert.equal(changed, true);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "X-User-Trace: keep-me");
  });

  it("stripFirerouterOwnedEnv drops ANTHROPIC_CUSTOM_HEADERS when only managed lines remain", () => {
    const { env } = stripFirerouterOwnedEnv({
      ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test\nx-anthropic-api-key: sk-ant",
    });
    assert.equal(Object.hasOwn(env, "ANTHROPIC_CUSTOM_HEADERS"), false);
  });

  it("stripFirerouterOwnedEnv leaves a user-only custom-header block untouched", () => {
    const { env, changed } = stripFirerouterOwnedEnv({
      ANTHROPIC_CUSTOM_HEADERS: "X-User-Trace: keep-me",
    });
    assert.equal(changed, false);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "X-User-Trace: keep-me");
  });

  it("returns non-FireRouter custom headers unchanged, by identity", () => {
    const foreign = "X-User-Header: keep-me";
    assert.equal(replaceFireworksKeyInCustomHeaders(foreign, "fw_new"), foreign);
    assert.equal(replaceFireworksKeyInCustomHeaders(undefined, "fw_new"), undefined);
    const headers = "X-Fireworks-Api-Key: fw_old";
    assert.equal(replaceFireworksKeyInCustomHeaders(headers, ""), headers);
  });

  it("never writes the retired routing-preference header", () => {
    assert.doesNotMatch(
      buildClaudeCustomHeaders({ fireworksKey: "fw_test", openaiKey: "sk-test" }),
      /x-routing-preference/i,
    );
  });

  it("resolves Anthropic key: flag beats global/env, else global, else settings", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env-12345";
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-anthropic-resolve-"));
      await writeGlobalConfig(home, {
        anthropicApiKey: "sk-ant-from-global-12345",
        harnesses: {},
      });

      assert.equal(await resolveAnthropicKey({ home }), "sk-ant-from-global-12345");
      assert.equal(
        await resolveAnthropicKey({
          apiKey: "sk-ant-from-flag-12345",
          home,
        }),
        "sk-ant-from-flag-12345",
      );
      assert.equal(
        await resolveAnthropicKey({ apiKey: "sk-ant-flag-only-12345" }),
        "sk-ant-flag-only-12345",
      );
      delete process.env.ANTHROPIC_API_KEY;
      assert.equal(
        await resolveAnthropicKey({
          settingsEnv: { ANTHROPIC_AUTH_TOKEN: "sk-ant-settings" },
        }),
        "sk-ant-settings",
      );
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("extracts the Anthropic BYOK key from an ANTHROPIC_CUSTOM_HEADERS string", () => {
    const headers = `${ANTHROPIC_BYOK_HEADER}: sk-ant-hdr-123\nx-routing-preference: 2`;
    assert.equal(anthropicKeyFromCustomHeaders(headers), "sk-ant-hdr-123");
    assert.equal(anthropicKeyFromCustomHeaders(""), "");
  });

  it("byokEnvFromHeaders rebuilds a settingsEnv from the stored Anthropic header", () => {
    assert.deepEqual(
      byokEnvFromHeaders({ [ANTHROPIC_BYOK_HEADER]: "sk-ant-h" }),
      { ANTHROPIC_CUSTOM_HEADERS: `${ANTHROPIC_BYOK_HEADER}: sk-ant-h` },
    );
    assert.deepEqual(byokEnvFromHeaders({}), {});
    assert.deepEqual(byokEnvFromHeaders({ "x-other": "v" }), {});
  });

  it("recovers the Anthropic BYOK key that lives only in ANTHROPIC_CUSTOM_HEADERS (re-on)", async () => {
    const savedA = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      // No flag, no global, no env — the key exists only in the header line, as
      // FireRouter mode stores it. The resolver must read it back.
      const settingsEnv = byokEnvFromHeaders({
        [ANTHROPIC_BYOK_HEADER]: "sk-ant-only-in-header-123",
      });
      assert.equal(await resolveAnthropicKey({ settingsEnv }), "sk-ant-only-in-header-123");
    } finally {
      if (savedA !== undefined) process.env.ANTHROPIC_API_KEY = savedA;
    }
  });

});
