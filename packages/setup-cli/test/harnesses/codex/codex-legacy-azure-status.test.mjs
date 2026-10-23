import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import codexHarness from "../../../lib/harnesses/codex/index.mjs";
import { codexConfigPath } from "../../../lib/harnesses/codex/core.mjs";
import { withTempHome } from "../../helpers.mjs";

/**
 * Captures the text `codex status` prints for a config.toml. The legacy
 * `fireworks-azure` table left by pre-removal Azure/Foundry installs must
 * report as routed, and the auth line must match the table's own auth shape:
 * `env_key = "AZURE_API_KEY"` is an environment reference, not a stored literal.
 * @param {string} home
 * @param {string} raw config.toml contents
 * @returns {Promise<string>} the printed status text
 */
async function statusTextFor(home, raw) {
  await mkdir(path.dirname(codexConfigPath(home)), { recursive: true });
  await writeFile(codexConfigPath(home), raw, "utf8");
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    await codexHarness.status({ home });
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

const LEGACY_AZURE_BASE = "https://example-resource.services.ai.azure.com/openai/v1";

function legacyAzureRouting(authLine) {
  return [
    'model_provider = "fireworks-azure"',
    'model = "FW-GLM-5.2"',
    "",
    "[model_providers.fireworks-azure]",
    'name = "Fireworks Azure"',
    `base_url = "${LEGACY_AZURE_BASE}"`,
    'wire_api = "chat"',
    authLine,
    "requires_openai_auth = false",
  ].join("\n") + "\n";
}

describe("codex status for a leftover fireworks-azure routing", () => {
  it("labels env_key auth as an environment reference, not a stored literal", async () => {
    await withTempHome("codex-legacy-azure-env-", async (home) => {
      const prevKey = process.env.AZURE_API_KEY;
      process.env.AZURE_API_KEY = "azure-test-key-1234567890";
      try {
        const text = await statusTextFor(
          home,
          legacyAzureRouting('env_key = "AZURE_API_KEY"'),
        );

        assert.match(text, /Connection: on/);
        assert.match(text, /Provider: Fireworks on Microsoft Foundry/);
        assert.match(text, new RegExp(`Endpoint: ${LEGACY_AZURE_BASE}`));
        // Regression: {env:AZURE_API_KEY} must not render as
        // "stored in config" just because AZURE_API_KEY happens to be set.
        assert.match(text, /Auth: environment reference in config/);
        assert.doesNotMatch(text, /stored in config/);
      } finally {
        if (prevKey === undefined) {
          delete process.env.AZURE_API_KEY;
        } else {
          process.env.AZURE_API_KEY = prevKey;
        }
      }
    });
  });

  it("labels literal bearer auth as stored in config", async () => {
    await withTempHome("codex-legacy-azure-literal-", async (home) => {
      const text = await statusTextFor(
        home,
        legacyAzureRouting('experimental_bearer_token = "azure-test-key-1234567890"'),
      );

      assert.match(text, /Connection: on/);
      assert.match(text, /Provider: Fireworks on Microsoft Foundry/);
      assert.match(text, /Auth: stored in config/);
    });
  });

  it("reports missing auth when the legacy table has no key", async () => {
    await withTempHome("codex-legacy-azure-missing-", async (home) => {
      const text = await statusTextFor(home, legacyAzureRouting(""));
      assert.match(text, /Connection: on/);
      assert.match(text, /Auth: missing/);
    });
  });
});
