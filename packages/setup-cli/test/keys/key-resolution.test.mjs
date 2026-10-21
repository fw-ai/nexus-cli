import assert from "node:assert/strict";
import { describe, test } from "node:test";

import claude from "../../lib/harnesses/claude/index.mjs";
import opencode from "../../lib/harnesses/opencode/index.mjs";
import codex from "../../lib/harnesses/codex/index.mjs";
import pi from "../../lib/harnesses/pi/index.mjs";
import {
  resolveFireworksApiKey,
  resolveHarnessOnApiKey,
} from "../../lib/keys/harness-api-key.mjs";
import { promptForFireworksApiKey, resolveFireworksApiKeyValue } from "../../lib/keys/api-key.mjs";
import {
  FIREWORKS_API_KEY_ENV_REF,
  writeGlobalConfig,
} from "../../lib/config/global-config.mjs";
import {
  FW_CLAUDE_KEY,
  FW_CODEX_KEY,
  FW_OPENCODE_KEY,
  FPK_KEY,
  seedKeychainConfig,
  withTempHome,
  withoutEnvFireworksKey,
  writeClaudeSettings,
  writeCodexConfig,
  writeNativeAnthropicSettings,
  writeOpencodeConfig,
} from "../helpers.mjs";
import { OPENCODE_API_KEY_ENV_REF } from "../../lib/harnesses/opencode/core.mjs";
import { resetSecretStoreForTests } from "../../lib/keys/secret-store.mjs";
import { PI_API_KEY_ENV_REF, piAuthPath } from "../../lib/harnesses/pi/core.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function harnessCtx(home) {
  return {
    home,
    settingsPath: "",
    configPath: "",
    dataDir: "",
    apiKey: "",
    apiKeyFromFlag: false,
    baseUrl: "",
    main: "",
    opus: "",
    sonnet: "",
    haiku: "",
    fable: "",
    subagent: "",
    slot: "",
    search: "",
    json: false,
    harnesses: "",
    apiKeyMode: "",
  };
}

async function writePiAuth(home, apiKey) {
  const authPath = piAuthPath(home);
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(
    authPath,
    `${JSON.stringify({ fireworks: { type: "api_key", key: apiKey } }, null, 2)}\n`,
  );
}

describe("harness resolveKey", () => {
  test("claude returns harness-local Fireworks key", async () => {
    await withTempHome("claude-key", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      await writeOpencodeConfig(home, FW_OPENCODE_KEY);
      const key = await claude.resolveKey(harnessCtx(home));
      assert.equal(key, FW_CLAUDE_KEY);
    });
  });

  test("claude skips non-Fireworks-shaped tokens", async () => {
    await withTempHome("claude-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const key = await claude.resolveKey(harnessCtx(home));
      assert.equal(key, "");
    });
  });

  test("claude skips fpk_ tokens", async () => {
    await withTempHome("claude-fpk", async (home) => {
      await writeClaudeSettings(home, FPK_KEY);
      const key = await claude.resolveKey(harnessCtx(home));
      assert.equal(key, "");
    });
  });

  test("opencode returns harness-local Fireworks key", async () => {
    await withTempHome("opencode-key", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const configPath = await writeOpencodeConfig(home, FW_OPENCODE_KEY);
      const key = await opencode.resolveKey(harnessCtx(home));
      assert.equal(key, FW_OPENCODE_KEY);
      assert.ok(configPath);
    });
  });

  test("opencode resolves env-ref to FIREWORKS_API_KEY", async () => {
    await withTempHome("opencode-envref", async (home) => {
      await writeOpencodeConfig(home, OPENCODE_API_KEY_ENV_REF);
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FW_OPENCODE_KEY;
      try {
        const key = await opencode.resolveKey(harnessCtx(home));
        assert.equal(key, FW_OPENCODE_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("codex returns harness-local bearer token without env", async () => {
    await withoutEnvFireworksKey(async () => {
      await withTempHome("codex-bearer-key", async (home) => {
        await writeCodexConfig(home, { apiKey: FW_CODEX_KEY });
        const key = await codex.resolveKey(harnessCtx(home));
        assert.equal(key, FW_CODEX_KEY);
      });
    });
  });

  test("codex resolves env_key to FIREWORKS_API_KEY", async () => {
    await withTempHome("codex-envref", async (home) => {
      await writeCodexConfig(home, { envRef: true });
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FW_CODEX_KEY;
      try {
        const key = await codex.resolveKey(harnessCtx(home));
        assert.equal(key, FW_CODEX_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("codex resolveKey returns empty when fireworks routing is inactive", async () => {
    await withoutEnvFireworksKey(async () => {
      await withTempHome("codex-inactive", async (home) => {
        const key = await codex.resolveKey(harnessCtx(home));
        assert.equal(key, "");
      });
    });
  });

  test("pi resolves env-ref to FIREWORKS_API_KEY", async () => {
    await withTempHome("pi-envref", async (home) => {
      await writePiAuth(home, PI_API_KEY_ENV_REF);
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FW_CLAUDE_KEY;
      try {
        const key = await pi.resolveKey(harnessCtx(home));
        assert.equal(key, FW_CLAUDE_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });
});

describe("resolveFireworksApiKey with harness resolveKey", () => {
  test("claude chain prefers harness-local key over env", async () => {
    await withTempHome("chain-claude-local", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const ctx = harnessCtx(home);
      await withoutEnvFireworksKey(async () => {
        const resolved = await resolveFireworksApiKey({
          resolveKey: () => claude.resolveKey(ctx),
          home,
        });
        assert.equal(resolved, FW_CLAUDE_KEY);
      });
    });
  });

  test("claude chain falls back to FIREWORKS_API_KEY env", async () => {
    await withTempHome("chain-claude-env", async (home) => {
      await writeNativeAnthropicSettings(home);
      const ctx = harnessCtx(home);
      const resolved = await resolveFireworksApiKey({
        resolveKey: () => claude.resolveKey(ctx),
        home,
        apiKey: "",
      });
      // resolveFireworksApiKey reads process.env.FIREWORKS_API_KEY last;
      // runCli clears it via NO_ENV_KEY but unit tests inherit shell env.
      // Pass explicit env via the test's expectation: empty harness key + no global config
      // means we need env set in process for this assertion.
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FW_CLAUDE_KEY;
      try {
        const key = await resolveFireworksApiKey({
          resolveKey: () => claude.resolveKey(ctx),
          home,
        });
        assert.equal(key, FW_CLAUDE_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("opencode chain ignores Claude settings", async () => {
    await withTempHome("chain-oc-only", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      await writeOpencodeConfig(home, FW_OPENCODE_KEY);
      const ctx = harnessCtx(home);
      await withoutEnvFireworksKey(async () => {
        const resolved = await resolveFireworksApiKey({
          resolveKey: () => opencode.resolveKey(ctx),
          home,
        });
        assert.equal(resolved, FW_OPENCODE_KEY);
      });
    });
  });
});

describe("resolveHarnessOnApiKey", () => {
  test("uses keychain ref when env is unset", async () => {
    await withTempHome("on-global-keychain", async (home) => {
      await seedKeychainConfig(home, "fw_global_key_12345");

      await withoutEnvFireworksKey(async () => {
        const resolved = await resolveHarnessOnApiKey({
          home,
          harnessEnvRef: PI_API_KEY_ENV_REF,
        });
        assert.equal(resolved.apiKey, "fw_global_key_12345");
        assert.equal(resolved.apiKeyFromFlag, false);
        assert.equal(resolved.effectiveKey, "fw_global_key_12345");
        assert.equal(resolved.source, "global-keychain");
      });
    });
  });

  test("uses legacy global env ref when FIREWORKS_API_KEY is set", async () => {
    await withTempHome("on-global-envref", async (home) => {
      await writeGlobalConfig(home, {
        apiKey: FIREWORKS_API_KEY_ENV_REF,
        harnesses: { pi: { enabled: false } },
      });

      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = "fw_test_key_12345";
      try {
        const resolved = await resolveHarnessOnApiKey({
          home,
          harnessEnvRef: PI_API_KEY_ENV_REF,
        });
        assert.equal(resolved.apiKey, "fw_test_key_12345");
        assert.equal(resolved.apiKeyFromFlag, false);
        assert.equal(resolved.source, "global-env-ref");
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("falls back to env when global config has no key", async () => {
    await withTempHome("on-env-only", async (home) => {
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = "fw_test_key_12345";
      try {
        const resolved = await resolveHarnessOnApiKey({
          home,
          harnessEnvRef: OPENCODE_API_KEY_ENV_REF,
        });
        assert.equal(resolved.apiKey, "fw_test_key_12345");
        assert.equal(resolved.source, "env");
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("falls back to harness-local literal when global and env are unset", async () => {
    await withTempHome("on-harness-literal", async (home) => {
      const harnessKey = "fw_harness_only_key_123456";
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        await withoutEnvFireworksKey(async () => {
          const resolved = await resolveHarnessOnApiKey({
            home,
            harnessEnvRef: OPENCODE_API_KEY_ENV_REF,
            getExistingHarnessKey: async () => harnessKey,
          });
          assert.equal(resolved.effectiveKey, harnessKey);
          assert.equal(resolved.source, "harness-local-literal");
          assert.equal(resolved.apiKey, harnessKey);
          assert.equal(resolved.reusedExistingKey, true);
        });
      } finally {
        if (prevHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = prevHome;
        }
      }
    });
  });
});

describe("resolveHarnessOnApiKey interactive prompt", () => {
  test("prompts as a last resort and reports source prompt", async () => {
    await withTempHome("on-prompt", async (home) => {
      resetSecretStoreForTests();
      await withoutEnvFireworksKey(async () => {
        const resolved = await resolveHarnessOnApiKey({
          home,
          harnessEnvRef: OPENCODE_API_KEY_ENV_REF,
          promptForKey: async () => FW_OPENCODE_KEY,
        });
        assert.equal(resolved.effectiveKey, FW_OPENCODE_KEY);
        assert.equal(resolved.source, "prompt");
        assert.equal(resolved.apiKey, FW_OPENCODE_KEY);
      });
    });
  });

  test("throws the usual error when the prompt yields nothing", async () => {
    await withTempHome("on-prompt-decline", async (home) => {
      resetSecretStoreForTests();
      await withoutEnvFireworksKey(async () => {
        await assert.rejects(
          resolveHarnessOnApiKey({
            home,
            harnessEnvRef: OPENCODE_API_KEY_ENV_REF,
            promptForKey: async () => "",
          }),
          /No Fireworks API key found/,
        );
      });
    });
  });
});

describe("promptForFireworksApiKey", () => {
  const tty = { isTTY: true };
  const verifyOk = async () => ({
    ok: true,
    reason: "",
    email: "",
    accountId: "",
    status: 200,
    detail: "",
  });

  test("returns empty without prompting on non-TTY stdin", async () => {
    await withTempHome("prompt-nontty", async (home) => {
      const result = await promptForFireworksApiKey(home, {
        input: { isTTY: false },
        readSecretFn: async () => {
          throw new Error("should not prompt");
        },
      });
      assert.equal(result, "");
    });
  });

  test("stores a well-formed key so later resolves find it", async () => {
    await withTempHome("prompt-store", async (home) => {
      resetSecretStoreForTests();
      await withoutEnvFireworksKey(async () => {
        const result = await promptForFireworksApiKey(home, {
          input: tty,
          readSecretFn: async () => FW_CLAUDE_KEY,
          verifyApiKey: verifyOk,
        });
        assert.equal(result, FW_CLAUDE_KEY);
        assert.equal(await resolveFireworksApiKeyValue({ home }), FW_CLAUDE_KEY);
      });
    });
  });

  test("re-asks on blank or malformed entries", async () => {
    await withTempHome("prompt-retry", async (home) => {
      await withoutEnvFireworksKey(async () => {
        const answers = ["", "sk-ant-not-a-fireworks-key", FW_CLAUDE_KEY];
        const result = await promptForFireworksApiKey(home, {
          input: tty,
          readSecretFn: async () => answers.shift(),
          verifyApiKey: verifyOk,
        });
        assert.equal(result, FW_CLAUDE_KEY);
        assert.equal(answers.length, 0);
      });
    });
  });

  test("gives up after repeated bad entries", async () => {
    await withTempHome("prompt-giveup", async (home) => {
      let calls = 0;
      const result = await promptForFireworksApiKey(home, {
        input: tty,
        readSecretFn: async () => {
          calls += 1;
          return "bogus";
        },
        verifyApiKey: verifyOk,
      });
      assert.equal(result, "");
      assert.equal(calls, 5);
    });
  });
});
