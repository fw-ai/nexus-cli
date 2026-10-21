import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertRequestedModelsServable,
  assertRequestedModelServable,
  isModelIdValidationApplicable,
} from "../../lib/fireworks/model-servability.mjs";
import { cacheServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel } from "../helpers.mjs";

// Each subtest must start cache-clean: the TTL-aware loader persists the mocked
// fetch on success, so a leftover fresh cache would serve a later subtest
// instead of exercising the fetch path.
function clearCatalogCache() {
  cacheServerlessCatalogSnapshot(null);
}

describe("model-servability isModelIdValidationApplicable", () => {
  it("is false for empty / no model", () => {
    assert.equal(isModelIdValidationApplicable(""), false);
    assert.equal(isModelIdValidationApplicable(undefined), false);
  });

  it("is false for firerouter gateway ids", () => {
    assert.equal(isModelIdValidationApplicable("firerouter"), false);
    assert.equal(isModelIdValidationApplicable("firerouter/balanced"), false);
    assert.equal(isModelIdValidationApplicable("firerouter/claude-opus-5/kimi-k3"), false);
    assert.equal(isModelIdValidationApplicable("firerouter/"), true);
    assert.equal(isModelIdValidationApplicable("firerouter//kimi"), true);
    assert.equal(isModelIdValidationApplicable("firerouter/.."), true);
    assert.equal(isModelIdValidationApplicable("claude-default"), true);
    assert.equal(isModelIdValidationApplicable("claude-opus-5"), false);
  });

  it("is true for firerouter lookalikes so the catalog rejects them", () => {
    assert.equal(isModelIdValidationApplicable("foo/firerouter-clone"), true);
    assert.equal(isModelIdValidationApplicable("firerouterx/y"), true);
  });

  it("is false for the auto mix and auto-* variants", () => {
    assert.equal(isModelIdValidationApplicable("auto"), false);
    assert.equal(isModelIdValidationApplicable("Auto"), false);
    assert.equal(isModelIdValidationApplicable("auto[1m]"), false);
    assert.equal(isModelIdValidationApplicable("auto-instant"), false);
    assert.equal(isModelIdValidationApplicable("auto-instant[1m]"), false);
    assert.equal(isModelIdValidationApplicable("auto-smart"), true, "Cursor-native id still catalog-checked");
    assert.equal(
      isModelIdValidationApplicable("accounts/auto-corp/models/private-model"),
      true,
      "an auto-shaped account is not a gateway mix",
    );
  });

  it("is false for custom deployment ids", () => {
    assert.equal(
      isModelIdValidationApplicable("accounts/example-account/deployments/test-deployment"),
      false,
    );
  });

  it("is true for ordinary slugs and full ids", () => {
    assert.equal(isModelIdValidationApplicable("glm-5p2"), true);
    assert.equal(isModelIdValidationApplicable("not-a-real-model"), true);
    assert.equal(
      isModelIdValidationApplicable("accounts/fireworks/models/glm-5p2"),
      true,
    );
  });
});

describe("model-servability assertRequestedModelsServable", () => {
  // Catalog mock containing glm-5p2; its -latest alias comes from the row's
  // `aliases` field, not from any static mapping.
  function withFetchMock(models, fn) {
    clearCatalogCache();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ object: "list", data: models }),
    });
    return fn().finally(() => {
      globalThis.fetch = previousFetch;
    });
  }

  it("throws for an id not in the catalog", async () => {
    await withFetchMock([mockServerlessModel({
      aliases: ["accounts/fireworks/routers/glm-latest"],
    })], async () => {
      await assert.rejects(
        () => assertRequestedModelServable("not-a-real-model", {
          apiKey: "fw_test_key",
        }),
        /not available on Fireworks/,
      );
    });
  });

  it("throws for firerouter lookalikes instead of writing junk config", async () => {
    await withFetchMock([mockServerlessModel({
      aliases: ["accounts/fireworks/routers/glm-latest"],
    })], async () => {
      for (const id of ["foo/firerouter-clone", "firerouterx/y"]) {
        await assert.rejects(
          () => assertRequestedModelServable(id, {
            apiKey: "fw_test_key",
          }),
          /not available on Fireworks/,
          id,
        );
      }
    });
  });

  it("does not treat a catalog slug as a match for a different path", async () => {
    await withFetchMock([mockServerlessModel({
      id: "accounts/fireworks/models/kimi-k3",
    })], async () => {
      for (const id of [
        "fireworks/kimi-k3",
        "fireworks-ai/kimi-k3",
        "router/kimi-k3",
        "accounts/acme/models/kimi-k3",
        "firerouter/",
        "firerouter//kimi",
      ]) {
        await assert.rejects(
          () => assertRequestedModelServable(id, {
            apiKey: "fw_test_key",
          }),
          /not available on Fireworks/,
          id,
        );
      }
    });
  });

  it("allows a pinned version present in the catalog", async () => {
    await withFetchMock([mockServerlessModel()], async () => {
      await assert.doesNotReject(() =>
        assertRequestedModelServable("glm-5p2", {
          apiKey: "fw_test_key",
        }),
      );
    });
  });

  it("allows a -latest alias resolved in the catalog", async () => {
    await withFetchMock([mockServerlessModel({
      aliases: ["accounts/fireworks/routers/glm-latest"],
    })], async () => {
      await assert.doesNotReject(() =>
        assertRequestedModelServable("glm-latest", {
          apiKey: "fw_test_key",
        }),
      );
    });
  });

  it("matches by full accounts/fireworks resource id", async () => {
    await withFetchMock([mockServerlessModel()], async () => {
      await assert.doesNotReject(() =>
        assertRequestedModelServable("accounts/fireworks/models/glm-5p2", {
          apiKey: "fw_test_key",
        }),
      );
    });
  });

  it("always allows firerouter and custom deployments without fetching", async () => {
    clearCatalogCache();
    let fetched = false;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetched = true; return { ok: true, json: async () => ({ object: "list", data: [] }) }; };
    try {
      await assertRequestedModelServable("firerouter", { apiKey: "fw_test_key" });
      await assertRequestedModelServable("auto", { apiKey: "fw_test_key" });
      await assertRequestedModelServable("auto-instant", { apiKey: "fw_test_key" });
      await assertRequestedModelServable("accounts/u/deployments/x", { apiKey: "fw_test_key" });
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("skips validation when no model is selected", async () => {
    await assert.doesNotReject(() =>
      assertRequestedModelsServable(["", undefined], { apiKey: "fw_test_key" }),
    );
  });

  it("skips validation when the catalog fetch fails (offline)", async () => {
    clearCatalogCache();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("offline"); };
    try {
      await assertRequestedModelServable("not-a-real-model", { apiKey: "fw_test_key" });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("validates every applicable id in one fetch", async () => {
    clearCatalogCache();
    let fetchCount = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return { ok: true, json: async () => ({ object: "list", data: [mockServerlessModel({ aliases: ["accounts/fireworks/routers/glm-latest"] })] }) };
    };
    try {
      // glm-5p2 + glm-latest are in the catalog; the bogus one must surface.
      await assert.rejects(
        () => assertRequestedModelsServable(
          ["glm-5p2", "glm-latest", "firerouter", "auto", "", "not-a-real-model"],
          { apiKey: "fw_test_key" },
        ),
        /not available on Fireworks/,
      );
      assert.equal(fetchCount, 1, "catalog fetched once for the whole batch");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});


describe("model-servability probeModelServable", () => {
  it("404 means retired; 200/429/other-4xx means it serves", async () => {
    const { probeModelServable } = await import("../../lib/fireworks/model-servability.mjs");
    const prev = process.env.NEXUS_TEST;
    delete process.env.NEXUS_TEST;
    try {
      assert.equal(await probeModelServable("retired", "key", { fetchImpl: async () => new Response("Model not found", { status: 404 }) }), false);
      assert.equal(await probeModelServable("live", "key", { fetchImpl: async () => new Response("{}", { status: 200 }) }), true);
      assert.equal(await probeModelServable("limited", "key", { fetchImpl: async () => new Response("{}", { status: 429 }) }), true);
    } finally {
      if (prev !== undefined) process.env.NEXUS_TEST = prev;
    }
  });

  it("network failure keeps the model (fail-open); NEXUS_TEST gates real calls", async () => {
    const { probeModelServable } = await import("../../lib/fireworks/model-servability.mjs");
    assert.equal(await probeModelServable("anything", "key", { fetchImpl: () => { throw new Error("must not be called"); } }), true);
    const prev = process.env.NEXUS_TEST;
    delete process.env.NEXUS_TEST;
    try {
      assert.equal(await probeModelServable("m", "key", { fetchImpl: async () => { throw new Error("offline"); } }), true);
    } finally {
      if (prev !== undefined) process.env.NEXUS_TEST = prev;
    }
  });

  it("servableModels filters in parallel, order-preserving", async () => {
    const { servableModels } = await import("../../lib/fireworks/model-servability.mjs");
    const prev = process.env.NEXUS_TEST;
    delete process.env.NEXUS_TEST;
    try {
      const statuses = { a: 200, b: 404, c: 200 };
      const out = await servableModels(["a", "b", "c"], "key", {
        fetchImpl: async (url, init) => new Response("", { status: statuses[JSON.parse(init.body).model] }),
      });
      assert.deepEqual(out, ["a", "c"]);
    } finally {
      if (prev !== undefined) process.env.NEXUS_TEST = prev;
    }
  });
});
