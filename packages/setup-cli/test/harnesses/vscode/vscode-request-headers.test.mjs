import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { withFireconnectRequestHeaders } from "../../../lib/harnesses/vscode/request-headers.mjs";

describe("vscode request headers", () => {
  it("writes anthropic_api_key on firerouter models when BYOK is present", () => {
    const model = withFireconnectRequestHeaders(
      { id: "firerouter", name: "FireRouter", url: "https://api.fireworks.ai/inference" },
      { byokHeaders: { "x-anthropic-api-key": "sk-ant-byok" } },
    );
    assert.equal(model.anthropic_api_key, "sk-ant-byok");
    assert.equal(model.requestHeaders["x-anthropic-api-key"], "sk-ant-byok");
  });

  it("drops anthropic_api_key from non-firerouter models", () => {
    const model = withFireconnectRequestHeaders(
      {
        id: "glm-fast-latest",
        anthropic_api_key: "sk-ant-stale",
        requestHeaders: { "x-anthropic-api-key": "sk-ant-stale" },
      },
      { byokHeaders: { "x-anthropic-api-key": "sk-ant-byok" } },
    );
    assert.equal(model.anthropic_api_key, undefined);
    assert.equal(model.requestHeaders?.["x-anthropic-api-key"], undefined);
  });

  it("drops a routing-preference header left by an earlier release", () => {
    const model = withFireconnectRequestHeaders(
      {
        id: "firerouter",
        name: "FireRouter",
        url: "https://api.fireworks.ai/inference",
        requestHeaders: { "x-routing-preference": "3", "X-User-Trace": "keep-me" },
      },
      { byokHeaders: {} },
    );
    assert.equal(model.requestHeaders["x-routing-preference"], undefined);
    assert.equal(model.requestHeaders["X-User-Trace"], "keep-me");
  });

  it("clears a routing-preference an earlier `on` wrote when none is passed", () => {
    const model = withFireconnectRequestHeaders(
      { id: "firerouter", requestHeaders: { "x-routing-preference": "5" } },
      { byokHeaders: {} },
    );
    assert.equal(model.requestHeaders?.["x-routing-preference"], undefined);
  });

  it("replaces an earlier routing-preference with the one passed", () => {
    const model = withFireconnectRequestHeaders(
      { id: "firerouter", requestHeaders: { "x-routing-preference": "5" } },
      { byokHeaders: { "x-routing-preference": "1" } },
    );
    assert.equal(model.requestHeaders["x-routing-preference"], "1");
  });

  it("keeps the user's own headers while clearing a stale routing-preference", () => {
    const model = withFireconnectRequestHeaders(
      { id: "firerouter", requestHeaders: { "x-routing-preference": "5", "X-User-Trace": "keep" } },
      { byokHeaders: {} },
    );
    assert.equal(model.requestHeaders?.["x-routing-preference"], undefined);
    assert.equal(model.requestHeaders["X-User-Trace"], "keep");
  });
});
