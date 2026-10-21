import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPiCustomFireworksModelEntry,
  isPiNexusOnlyModelId,
} from "../../../lib/harnesses/pi/core.mjs";
import { FIREROUTER_ROUTER_ID, fullFireworksResourceId } from "../../../lib/fireworks/model-id.mjs";

const GLM_LATEST = "accounts/fireworks/routers/glm-latest";

describe("Pi fireworks rows", () => {
  it("isPiNexusOnlyModelId separates Nexus specials from Pi's catalog ids", () => {
    assert.equal(isPiNexusOnlyModelId("auto"), true);
    assert.equal(isPiNexusOnlyModelId("auto-instant"), true);
    assert.equal(isPiNexusOnlyModelId("firerouter"), true);
    assert.equal(isPiNexusOnlyModelId("accounts/example-account/deployments/test-deployment"), true);
    assert.equal(isPiNexusOnlyModelId(GLM_LATEST), false);
    assert.equal(isPiNexusOnlyModelId("glm-5p2"), false);
  });

  it("buildPiCustomFireworksModelEntry gives auto its spec limits and per-row session affinity", () => {
    const entry = buildPiCustomFireworksModelEntry("auto", "Auto");
    assert.equal(entry.id, "auto");
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.deepEqual(entry.compat, { sendSessionAffinityHeaders: true });
  });

  it("buildPiCustomFireworksModelEntry enables image input for firerouter", () => {
    const entry = buildPiCustomFireworksModelEntry(
      FIREROUTER_ROUTER_ID,
      "FireRouter",
    );
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.maxTokens, 131_072);
  });

  it("buildPiCustomFireworksModelEntry shares firerouter limits for firerouter* ids", () => {
    const entry = buildPiCustomFireworksModelEntry("firerouter/x", "X");
    assert.equal(entry.id, "firerouter/x");
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.maxTokens, 131_072);
  });

});

describe("fullFireworksResourceId router classification", () => {
  // Regression: router slugs not in a hand-maintained list (e.g. sample-model-fast,
  // any new *-fast/*-latest/*-turbo) must still expand to routers/, not models/.
  // A mis-expanded active model failed to match its catalog row in
  // models.json, yielding a duplicate models[] entry.
  it("expands router-suffixed slugs to routers/ even when not in a static list", () => {
    assert.equal(
      fullFireworksResourceId("sample-model-fast"),
      "accounts/fireworks/routers/sample-model-fast",
    );
    assert.equal(
      fullFireworksResourceId("glm-5p2-fast"),
      "accounts/fireworks/routers/glm-5p2-fast",
    );
    assert.equal(
      fullFireworksResourceId("deepseek-v4-flash"),
      "accounts/fireworks/models/deepseek-v4-flash",
    );
  });

  it("expands documented US-only slugs by the shared suffix heuristic", () => {
    // US-only router slugs carry no `-latest`/`-fast` suffix, but each has a
    // static spec naming a documented US router — `isRouterShortId` counts a
    // `-us` slug with a spec as a router, so bare slugs expand under routers/.
    // Full `accounts/fireworks/routers/...-us` ids (as the API reports them)
    // pass through unchanged.
    assert.equal(
      fullFireworksResourceId("glm-5p3-flash-us"),
      "accounts/fireworks/routers/glm-5p3-flash-us",
    );
    // The full ids the catalog actually reports as US routers pass through.
    assert.equal(
      fullFireworksResourceId("accounts/fireworks/routers/glm-5p3-flash-us"),
      "accounts/fireworks/routers/glm-5p3-flash-us",
    );
  });

  it("classifies firerouter* variants as routers, not just the bare firerouter slug", () => {
    assert.equal(
      fullFireworksResourceId("firerouter"),
      "accounts/fireworks/routers/firerouter",
    );
    assert.equal(
      fullFireworksResourceId("firerouter-1m"),
      "accounts/fireworks/routers/firerouter-1m",
    );
    assert.equal(
      fullFireworksResourceId("firerouter-fast-latest"),
      "accounts/fireworks/routers/firerouter-fast-latest",
    );
    // A slash-bearing firerouter gateway pattern passes through unchanged and is
    // handled by isFirerouterModelPattern at the spec layer.
    assert.equal(fullFireworksResourceId("firerouter/x"), "firerouter/x");
  });

  it("leaves the auto model id unexpanded (no accounts/fireworks path exists)", () => {
    assert.equal(fullFireworksResourceId("auto"), "auto");
    assert.equal(fullFireworksResourceId("Auto"), "auto");
    assert.equal(fullFireworksResourceId("auto[1m]"), "auto");
    assert.equal(fullFireworksResourceId("auto-instant"), "auto-instant");
  });
});
