import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cachedListRateTable,
  clearListPriceCache,
  deletePersistedListPriceCache,
  getListPriceRates,
  isListPriceCacheFresh,
  parseModelsDevListPrices,
  readListPriceCache,
  refreshListPriceCache,
  reloadListPriceRates,
  setListPriceCacheRates,
} from "../../lib/pricing/list-price-cache.mjs";
import {
  canonicalOpenAiModelId,
  isOpenAiPricedModelId,
  providerListPricing,
} from "../../lib/demo/list-pricing.mjs";

// Never touch the network from specs; refreshListPriceCache short-circuits.
process.env.NEXUS_TEST = "1";
// HOME-based cache paths like the serverless catalog spec: opt out of the
// shared NEXUS_CACHE_DIR override, each case gets its own temp HOME.
delete process.env.NEXUS_CACHE_DIR;

function withTempHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "fc-list-price-test-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const done = () => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  };
  let result;
  try {
    result = fn(home);
  } catch (error) {
    done();
    throw error;
  }
  if (result?.then) {
    return result.then(
      (value) => {
        done();
        return value;
      },
      (error) => {
        done();
        throw error;
      },
    );
  }
  done();
  return result;
}

function fixtureDoc() {
  return {
    anthropic: {
      models: {
        "claude-opus-5-5": {
          id: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
          experimental: {
            modes: { fast: { cost: { input: 8, output: 40, cache_read: 0.4, cache_write: 10 } } },
          },
        },
        "claude-sonnet-5": {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        },
        "retired-row": {
          id: "retired-row",
          name: "Retired",
          cost: { input: 0, output: 0 },
        },
      },
    },
    openai: {
      models: {
        "gpt-5.5": {
          id: "gpt-5.5",
          name: "GPT-5.5",
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: "context", size: 272000 } }],
          },
        },
        "gpt-9-future": {
          id: "gpt-9-future",
          name: "GPT-9 Future",
          cost: { input: 7, output: 35, cache_read: 0.7, cache_write: 8.75 },
        },
      },
    },
  };
}

describe("parseModelsDevListPrices", () => {
  it("derives Anthropic rows with 5m/1h write rules and fast tiers", () => {
    const rates = parseModelsDevListPrices(JSON.stringify(fixtureDoc()));
    assert.deepEqual(rates.anthropic["claude-opus-5-5"], {
      label: "Claude Opus 5.5",
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      source: "https://models.dev",
      fast: { input: 8, output: 40, cacheRead: 0.4, cacheWrite5m: 10, cacheWrite1h: 16 },
    });
  });

  it("derives OpenAI writes and long-context tiers from context rows", () => {
    const rates = parseModelsDevListPrices(JSON.stringify(fixtureDoc()));
    const row = rates.openai["gpt-5.5"];
    // No cache_write in the fixture: single automatic cache at 1.25x input.
    assert.equal(row.cacheWrite5m, 6.25);
    assert.equal(row.cacheWrite1h, 6.25);
    assert.deepEqual(row.long, {
      input: 10,
      output: 45,
      cacheRead: 1,
      cacheWrite5m: 12.5,
      cacheWrite1h: 12.5,
      threshold: 272000,
    });
  });

  it("skips unusable rows and rejects malformed bodies", () => {
    const rates = parseModelsDevListPrices(JSON.stringify(fixtureDoc()));
    assert.equal(rates.anthropic["retired-row"], undefined);
    assert.equal(parseModelsDevListPrices("not json"), null);
    assert.equal(parseModelsDevListPrices("{}"), null);
    assert.equal(parseModelsDevListPrices(JSON.stringify({ anthropic: {} })), null);
  });
});

describe("list-price disk cache", () => {
  it("round-trips through the HOME-scoped cache file", () => {
    withTempHome(() => {
      deletePersistedListPriceCache();
      assert.equal(readListPriceCache(), null);
      assert.equal(isListPriceCacheFresh(), false);
      const rates = parseModelsDevListPrices(JSON.stringify(fixtureDoc()));
      setListPriceCacheRates(rates, { persist: true });
      const cached = readListPriceCache();
      assert.ok(cached.cachedAt > 0);
      assert.equal(cached.rates.openai["gpt-9-future"].input, 7);
      assert.equal(isListPriceCacheFresh(), true);
      deletePersistedListPriceCache();
      assert.equal(readListPriceCache(), null);
    });
  });

  it("treats a zero-age cache as stale", () => {
    withTempHome((home) => {
      deletePersistedListPriceCache();
      mkdirSync(path.join(home, ".nexus"), { recursive: true });
      writeFileSync(
        path.join(home, ".nexus", "list-price-cache.json"),
        JSON.stringify({ cachedAt: 0, rates: { anthropic: {} } }),
      );
      assert.equal(isListPriceCacheFresh(), false);
      deletePersistedListPriceCache();
    });
  });

  it("reload picks up rows another process wrote without losing memory on a missing file", () => {
    withTempHome((home) => {
      const file = path.join(home, ".nexus", "list-price-cache.json");
      setListPriceCacheRates({ anthropic: {} }, { persist: true });
      assert.deepEqual(getListPriceRates(), { anthropic: {} });
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.rates.openai = { "gpt-9-future": { label: "GPT-9 Future", input: 7 } };
      writeFileSync(file, JSON.stringify(raw));
      assert.equal(getListPriceRates().openai, undefined, "memory is stale until reloaded");
      assert.equal(reloadListPriceRates().openai["gpt-9-future"].input, 7);
      rmSync(file, { force: true });
      assert.ok(reloadListPriceRates().openai, "vanished file keeps memory");
      clearListPriceCache();
    });
  });

  it("refresh short-circuits under NEXUS_TEST without network", async () => {
    await withTempHome(async () => {
      deletePersistedListPriceCache();
      assert.equal(await refreshListPriceCache(), false);
      setListPriceCacheRates(parseModelsDevListPrices(JSON.stringify(fixtureDoc())));
      try {
        assert.equal(await refreshListPriceCache(), true);
      } finally {
        clearListPriceCache();
      }
    });
  });
});

describe("providerListPricing with list-price cache", () => {
  it("prices cache-only models without a static row", () => {
    setListPriceCacheRates(parseModelsDevListPrices(JSON.stringify(fixtureDoc())));
    try {
      const rate = providerListPricing({ provider: "anthropic", modelId: "claude-opus-5-5" });
      assert.equal(rate.estimated, false);
      assert.equal(rate.label, "Claude Opus 5.5");
      assert.equal(rate.inputPerMillion, 4);
      assert.equal(rate.outputPerMillion, 20);
      assert.equal(rate.cachedInputPerMillion, 0.2);
      assert.equal(rate.source, "https://models.dev");
      const fast = providerListPricing({ provider: "anthropic", modelId: "claude-opus-5-5", speed: "fast" });
      assert.equal(fast.inputPerMillion, 8);
      assert.equal(fast.outputPerMillion, 40);
    } finally {
      clearListPriceCache();
    }
  });

  it("matches provider prefixes, context tags, and snapshot dates against cached keys", () => {
    setListPriceCacheRates(parseModelsDevListPrices(JSON.stringify(fixtureDoc())));
    try {
      for (const id of [
        "anthropic/claude-opus-5-5",
        "claude-opus-5-5[1m]",
        "claude-opus-5-5-20260922",
      ]) {
        assert.equal(
          providerListPricing({ provider: "anthropic", modelId: id }).inputPerMillion,
          4,
          id,
        );
      }
    } finally {
      clearListPriceCache();
    }
  });

  it("lets cached rows win over stale bundled rows", () => {
    setListPriceCacheRates({
      anthropic: {
        "claude-opus-5": {
          label: "Claude Opus 5",
          input: 4.5,
          output: 22,
          cacheRead: 0.45,
          cacheWrite5m: 5.5,
          cacheWrite1h: 9,
          source: "https://models.dev",
        },
      },
    });
    try {
      assert.equal(
        providerListPricing({ provider: "anthropic", modelId: "claude-opus-5" }).inputPerMillion,
        4.5,
      );
    } finally {
      clearListPriceCache();
    }
  });

  it("keeps bundled fast and long tiers when a cached row omits them", () => {
    setListPriceCacheRates({
      anthropic: {
        "claude-opus-5": {
          label: "Claude Opus 5",
          input: 4.5,
          output: 22,
          cacheRead: 0.45,
          cacheWrite5m: 5.5,
          cacheWrite1h: 9,
          source: "https://models.dev",
        },
      },
      openai: {
        "gpt-5.5": { label: "GPT-5.5", input: 5, output: 30, cacheRead: 0.5, source: "https://models.dev" },
      },
    });
    try {
      // Standard rate comes from the cache; the fast tier survives from the bundled row.
      assert.equal(
        providerListPricing({ provider: "anthropic", modelId: "claude-opus-5" }).inputPerMillion,
        4.5,
      );
      assert.equal(
        providerListPricing({ provider: "anthropic", modelId: "claude-opus-5", speed: "fast" }).inputPerMillion,
        10,
      );
      const long = providerListPricing({ provider: "openai", modelId: "gpt-5.5", inputTokens: 300_000 });
      assert.equal(long.contextTier, "long");
      assert.equal(long.inputPerMillion, 10);
    } finally {
      clearListPriceCache();
    }
  });

  it("classifies cache-only OpenAI ids without static aliases", () => {
    setListPriceCacheRates(parseModelsDevListPrices(JSON.stringify(fixtureDoc())));
    try {
      assert.equal(isOpenAiPricedModelId("gpt-9-future"), true);
      assert.equal(canonicalOpenAiModelId("openai/gpt-9-future"), "gpt-9-future");
      // Static rows still resolve with an empty cache behind them.
      assert.deepEqual(cachedListRateTable("openai")["gpt-9-future"].label, "GPT-9 Future");
    } finally {
      clearListPriceCache();
    }
  });

  it("falls back to bundled rows and estimated references with an empty cache", () => {
    clearListPriceCache();
    assert.equal(getListPriceRates(), null);
    assert.equal(
      providerListPricing({ provider: "anthropic", modelId: "claude-opus-5" }).inputPerMillion,
      5,
    );
    const unknown = providerListPricing({ provider: "anthropic", modelId: "claude-opus-9" });
    assert.equal(unknown.estimated, true);
    assert.equal(isOpenAiPricedModelId("gpt-9-future"), false);
  });
});
