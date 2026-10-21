import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AZURE_FOUNDRY_SUPPORTED_MODELS,
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  DEFAULT_AZURE_MODEL,
  azureFoundryDeploymentToSlug,
  effectiveAzureApiKey,
  isAzureBaseUrl,
  lookupAzureFoundryModelLimits,
  normalizeAzureBaseUrl,
  resolveAzureBaseUrl,
  resolveAzureFoundryModelSlug,
  resolveAzureOnApiKey,
} from "../../lib/fireworks/azure-core.mjs";

async function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

describe("normalizeAzureBaseUrl", () => {
  it("appends /openai/v1 to a bare project endpoint", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("strips trailing slashes before appending", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("leaves an already-suffixed openai/v1 base unchanged", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/openai/v1"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("rewrites the /models route to the openai/v1 base", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/models"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("completes a bare /openai segment", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/openai"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("reduces a portal project endpoint to the resource-root openai/v1 base", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/api/projects/msft-fw-foundry"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/api/projects/msft-fw-foundry/"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("preserves a custom path for non-Azure (proxy) hosts", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://gateway.example.com/fw"),
      "https://gateway.example.com/fw/openai/v1",
    );
  });

  it("returns empty string for empty input", () => {
    assert.equal(normalizeAzureBaseUrl(""), "");
    assert.equal(normalizeAzureBaseUrl(undefined), "");
  });
});

describe("isAzureBaseUrl", () => {
  it("matches Azure hosts", () => {
    assert.equal(isAzureBaseUrl("https://x.services.ai.azure.com"), true);
    assert.equal(isAzureBaseUrl("https://x.openai.azure.com/openai/v1"), true);
  });

  it("rejects the Fireworks gateway", () => {
    assert.equal(isAzureBaseUrl("https://api.fireworks.ai/inference/v1"), false);
  });
});

describe("resolveAzureBaseUrl", () => {
  it("uses flag, then configured, then harness-stored endpoint", () => {
    assert.equal(
      resolveAzureBaseUrl(
        { baseUrl: "flag", baseUrlFromFlag: true },
        { baseUrl: "configured" },
        "stored",
      ),
      "flag",
    );
    assert.equal(
      resolveAzureBaseUrl({}, { baseUrl: "configured" }, "stored"),
      "configured",
    );
    assert.equal(resolveAzureBaseUrl({}, {}, "stored"), "stored");
  });
});

describe("resolveAzureOnApiKey", () => {
  it("uses flag, then active harness key, then configured key, then env", async () => {
    const flagged = await resolveAzureOnApiKey({
      apiKey: "flag",
      apiKeyFromFlag: true,
      configuredApiKey: "configured",
      getExistingKey: async () => "stored",
    });
    assert.equal(flagged.apiKey, "flag");

    const stored = await resolveAzureOnApiKey({
      configuredApiKey: "configured",
      getExistingKey: async () => "stored",
    });
    assert.equal(stored.apiKey, "stored");

    const configured = await resolveAzureOnApiKey({ configuredApiKey: "configured" });
    assert.equal(configured.apiKey, "configured");
  });

  it("prefers an explicit flag key, stored literally", async () => {
    const result = await resolveAzureOnApiKey({ apiKey: "azkey123", apiKeyFromFlag: true });
    assert.deepEqual(result, { apiKey: "azkey123", apiKeyFromFlag: true, reusedExistingKey: false });
  });

  it("reuses an existing literal key", async () => {
    const result = await resolveAzureOnApiKey({ getExistingKey: async () => "stored-literal" });
    assert.deepEqual(result, { apiKey: "stored-literal", apiKeyFromFlag: true, reusedExistingKey: true });
  });

  it("reuses an existing env-ref without marking it literal", async () => {
    const result = await resolveAzureOnApiKey({ getExistingKey: async () => AZURE_API_KEY_ENV_REF });
    assert.deepEqual(result, { apiKey: AZURE_API_KEY_ENV_REF, apiKeyFromFlag: false, reusedExistingKey: true });
  });

  it("treats Pi's $AZURE_API_KEY ref as env-reference, not literal", async () => {
    // Pi stores its env reference as `$AZURE_API_KEY` (not `{env:AZURE_API_KEY}`).
    // resolveAzureOnApiKey must recognize that shape so enablePiAzure writes
    // models.json at default perms, not 0600 (no literal key is on disk).
    const result = await resolveAzureOnApiKey({ getExistingKey: async () => "$AZURE_API_KEY" });
    assert.deepEqual(result, { apiKey: "$AZURE_API_KEY", apiKeyFromFlag: false, reusedExistingKey: true });
  });

  it("treats the ${AZURE_API_KEY} ref form as env-reference, not literal", async () => {
    const result = await resolveAzureOnApiKey({ getExistingKey: async () => "${AZURE_API_KEY}" });
    assert.deepEqual(result, { apiKey: "${AZURE_API_KEY}", apiKeyFromFlag: false, reusedExistingKey: true });
  });

  it("a configured env-ref is not promoted to literal", async () => {
    await withEnv(AZURE_API_KEY_ENV, "env-azure-key", async () => {
      const result = await resolveAzureOnApiKey({ configuredApiKey: "$AZURE_API_KEY" });
      assert.equal(result.apiKeyFromFlag, false);
      assert.equal(result.apiKey, AZURE_API_KEY_ENV_REF);
    });
  });

  it("falls back to the AZURE_API_KEY env reference", async () => {
    await withEnv(AZURE_API_KEY_ENV, "env-azure-key", async () => {
      const result = await resolveAzureOnApiKey({});
      assert.deepEqual(result, { apiKey: AZURE_API_KEY_ENV_REF, apiKeyFromFlag: false, reusedExistingKey: false });
    });
  });

  it("throws when no key is available", async () => {
    await withEnv(AZURE_API_KEY_ENV, undefined, async () => {
      await assert.rejects(() => resolveAzureOnApiKey({}), /No Azure API key/);
    });
  });

  it("rejects Fireworks-shaped keys from flags, storage, config, and env", async () => {
    await assert.rejects(
      () => resolveAzureOnApiKey({ apiKey: "fw_wrong", apiKeyFromFlag: true }),
      /cannot be a Fireworks key/,
    );
    await assert.rejects(
      () => resolveAzureOnApiKey({ getExistingKey: async () => "fw_wrong" }),
      /cannot be a Fireworks key/,
    );
    await assert.rejects(
      () => resolveAzureOnApiKey({ configuredApiKey: "fw_wrong" }),
      /cannot be a Fireworks key/,
    );
    await withEnv(AZURE_API_KEY_ENV, "fw_wrong", async () => {
      await assert.rejects(
        () => resolveAzureOnApiKey({}),
        /cannot be a Fireworks key/,
      );
    });
  });
});

describe("effectiveAzureApiKey", () => {
  it("resolves the env reference to the real value", async () => {
    await withEnv(AZURE_API_KEY_ENV, "real-azure-key", async () => {
      assert.equal(effectiveAzureApiKey(AZURE_API_KEY_ENV_REF), "real-azure-key");
    });
  });

  it("returns literal keys untouched", () => {
    assert.equal(effectiveAzureApiKey("literal"), "literal");
  });

  it("returns empty for empty input", () => {
    assert.equal(effectiveAzureApiKey(""), "");
  });
});

describe("DEFAULT_AZURE_MODEL", () => {
  it("is a bare Foundry deployment name (no publisher prefix)", () => {
    assert.equal(typeof DEFAULT_AZURE_MODEL, "string");
    assert.ok(DEFAULT_AZURE_MODEL.length > 0);
    assert.doesNotMatch(DEFAULT_AZURE_MODEL, /^fireworks-ai\//);
  });
});

describe("azure Foundry model slug resolution", () => {
  it("every supported Foundry model maps to a Fireworks spec", () => {
    for (const [foundryId, slug] of Object.entries(AZURE_FOUNDRY_SUPPORTED_MODELS)) {
      assert.equal(azureFoundryDeploymentToSlug(foundryId), slug);
      assert.equal(resolveAzureFoundryModelSlug(foundryId), slug);
    }
  });

  it("maps FW-GLM-5.2 to glm-5p2 with 1M context limits", () => {
    assert.equal(azureFoundryDeploymentToSlug("FW-GLM-5.2"), "glm-5p2");
    assert.equal(resolveAzureFoundryModelSlug("FW-GLM-5.2"), "glm-5p2");
    const limits = lookupAzureFoundryModelLimits("FW-GLM-5.2");
    assert.equal(limits.contextWindow, 1_048_575);
    assert.equal(limits.maxTokens, 131_072);
  });

  it("maps supported Foundry catalog Model IDs to Fireworks specs", () => {
    assert.equal(resolveAzureFoundryModelSlug("FW-MiniMax-M2.5"), "minimax-m2p5");
    assert.equal(resolveAzureFoundryModelSlug("FW-Kimi-K2.7-Code"), "kimi-k2p7-code");
    assert.equal(resolveAzureFoundryModelSlug("FW-DeepSeek-V4-Flash"), "deepseek-v4-flash");
    assert.equal(resolveAzureFoundryModelSlug("FW-GLM-5.1"), "glm-5p1");
    assert.equal(resolveAzureFoundryModelSlug("FW-Kimi-K2.6"), "kimi-k2p6");
    assert.equal(resolveAzureFoundryModelSlug("FW-GPT-OSS-120B"), "gpt-oss-120b");
  });

  it("ignores Foundry catalog models without a Fireworks spec mapping", () => {
    assert.equal(resolveAzureFoundryModelSlug("FW-Qwen3.6-27B"), null);
    assert.equal(resolveAzureFoundryModelSlug("FW-GLM-4.7"), null);
    assert.equal(resolveAzureFoundryModelSlug("FW-Qwen-3.7-Plus"), null);
  });

  it("returns defaults for unknown deployment names", () => {
    assert.equal(resolveAzureFoundryModelSlug("custom-deployment"), null);
    const limits = lookupAzureFoundryModelLimits("FW-Kimi-K2-Instruct-0905");
    assert.equal(limits.contextWindow, 1_000_000);
  });
});
