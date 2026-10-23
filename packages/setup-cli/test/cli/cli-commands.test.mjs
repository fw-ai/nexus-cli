import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OPENCODE_API_KEY_ENV_REF } from "../../lib/harnesses/opencode/core.mjs";
import {
  FIREWORKS_INFERENCE_URL,
  FPK_KEY,
  FW_CLAUDE_KEY,
  GLM_FAST_LATEST,
  NO_ENV_KEY,
  readClaudeSettings,
  readOpencodeConfig,
  runCli,
  runCliJson,
  seedKeychainConfig,
  seedServerlessCatalogCache,
  SK_ANT_KEY,
  withTempHome,
  writeClaudeSettings,
  writeNativeAnthropicSettings,
  assertClaudeNativeTierSlots,
  assertClaudeRegisterablePicker,
  writeOpencodeConfig,
} from "../helpers.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import {
  cacheServerlessCatalogSnapshot,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";

// Alias routers (`*-latest`) only resolve to their base model/static spec when
// the flat catalog reports them via a row's `aliases` field — the static alias
// table is gone. Seed these rows (base model + alias) into the spawned CLI's
// HOME-scoped catalog cache so `on` can resolve labels, 1M context, and pricing.
const ON_CATALOG_ROWS = [
  {
    id: "accounts/fireworks/models/glm-5p3",
    display_name: "GLM 5.3",
    serverless_mode: "standard",
    aliases: ["accounts/fireworks/routers/glm-latest"],
  },
  {
    id: "accounts/fireworks/models/glm-5p3-flash",
    display_name: "GLM 5.3 Flash",
    serverless_mode: "standard",
    aliases: ["accounts/fireworks/routers/glm-flash-latest"],
    input_modalities: ["text", "image"],
  },
  {
    id: "accounts/fireworks/models/deepseek-v4-flash-0731",
    display_name: "DeepSeek V4 Flash (0731)",
    serverless_mode: "standard",
    aliases: ["accounts/fireworks/routers/deepseek-flash-latest"],
  },
  {
    id: "accounts/fireworks/models/kimi-k3-fast",
    display_name: "Kimi K3 Fast",
    serverless_mode: "fast",
    aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
    input_modalities: ["text", "image"],
    pricing: [
      { sku: "LLM input tokens (uncached)", amount: "4.5", unit: "1M tokens" },
      { sku: "LLM input tokens (cached)", amount: "0.45", unit: "1M tokens" },
      { sku: "LLM output tokens", amount: "22.5", unit: "1M tokens" },
    ],
  },
];

/**
 * Persist the alias-bearing catalog snapshot to `home`'s scoped cache so the
 * spawned CLI child lazy-loads it. Mirrors seedServerlessCatalogCache's
 * HOME juggling; our snapshot has real aliases so `seedOnCommandCatalog` leaves
 * it untouched.
 * @param {string} home
 */
function seedOnCatalog(home) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ON_CATALOG_ROWS));
  } finally {
    process.env.HOME = prevHome;
    setServerlessCatalogSnapshot(null);
  }
}

const ALT_FW_KEY = "fw_alt_test_key_00000000000000000";

/** Gateway stub that records each request's bearer key and answers 500. */
function startKeyRecordingGateway() {
  const keys = [];
  const server = createServer((req, res) => {
    keys.push((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    res.writeHead(500);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, keys, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const CLAUDE_STORED_FABLE_MODEL = "glm-flash-latest[1m]";
const CLAUDE_STORED_GLM_MODEL = `${GLM_FAST_LATEST}[1m]`;
const CLAUDE_STORED_DS_FLASH_MODEL = "deepseek-flash-latest[1m]";
const CLAUDE_STORED_FIREROUTER_MODEL = "firerouter[1m]";
const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

describe("fireconnect bare invocation", () => {
  test("prints help when not attached to a TTY", async () => {
    await withTempHome("bare-help", async (home) => {
      const result = await runCli([], { home });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Nexus/);
      assert.match(result.stdout, /Harness commands/);
      assert.match(result.stdout, /nexus <harness> help/);
    });
  });
});

describe("fireconnect help quick", () => {
  test("shows main commands without the full reference", async () => {
    await withTempHome("help-quick", async (home) => {
      const quick = await runCli(["help", "quick"], { home });
      const full = await runCli(["help"], { home });
      assert.equal(quick.code, 0, quick.stderr);
      assert.match(quick.stdout, /Get started/);
      assert.match(quick.stdout, /login\s+Sign in to Fireworks/);
      assert.match(quick.stdout, /claude\s+Route Claude Code/);
      assert.match(quick.stdout, /help\s+Full command reference/);
      assert.doesNotMatch(quick.stdout, /Global options/);
      assert.ok(
        quick.stdout.length < full.stdout.length,
        "quick help should be shorter than full help",
      );
    });
  });

  test("full help lists models as an alias for model list", async () => {
    await withTempHome("help-models-alias", async (home) => {
      const full = await runCli(["help"], { home });
      assert.equal(full.code, 0, full.stderr);
      assert.match(full.stdout, /model list\s+Browse serverless models\./);
      assert.match(full.stdout, /models\s+Alias for model list\./);
    });
  });
});

describe("harness help matches supported command features", () => {
  test("documents shared Azure options only on Azure-capable harnesses", async () => {
    await withTempHome("help-azure", async (home) => {
      for (const harness of ["opencode", "pi", "cursor", "vscode"]) {
        const result = await runCli(["help", harness], { home });
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /--azure/);
        assert.match(result.stdout, /Microsoft Foundry endpoint/);
      }
      const deepseek = await runCli(["help", "deepseek"], { home });
      assert.equal(deepseek.code, 0, deepseek.stderr);
      assert.doesNotMatch(deepseek.stdout, /--azure/);
      const codex = await runCli(["help", "codex"], { home });
      assert.doesNotMatch(codex.stdout, /--azure/);
      const claude = await runCli(["help", "claude"], { home });
      assert.doesNotMatch(claude.stdout, /--azure/);
      assert.match(claude.stdout, /Anthropic-compatible gateway URL override/);
    });
  });

  test("does not advertise ignored gateway base-url overrides", async () => {
    await withTempHome("help-baseurl", async (home) => {
      for (const harness of ["pi"]) {
        const result = await runCli(["help", harness], { home });
        assert.doesNotMatch(result.stdout, /Fireworks gateway URL override/);
        assert.match(result.stdout, /--base-url.*Microsoft Foundry endpoint/);
      }
      const codex = await runCli(["help", "codex"], { home });
      assert.doesNotMatch(codex.stdout, /--base-url/);
    });
  });

  test("documents optional usage, and provider keys under nexus auto rather than VS Code", async () => {
    const root = await runCli(["help"]);
    assert.match(root.stdout, /usage/);
    assert.match(root.stdout, /--refresh/);

    const vscode = await runCli(["help", "vscode"]);
    assert.doesNotMatch(vscode.stdout, /--routing-preference/);
    assert.doesNotMatch(vscode.stdout, /--anthropic-api-key/);
    assert.doesNotMatch(vscode.stdout, /--openai-api-key/);

    const auto = await runCli(["help", "auto"]);
    assert.match(auto.stdout, /--anthropic-api-key <key>\s+Save an Anthropic key/);
  });

  test("documents FireRouter caveats per harness", async () => {
    const claude = await runCli(["claude", "help"]);
    assert.equal(claude.code, 0, claude.stderr);
    assert.match(claude.stdout, /Options for on/);
    assert.match(claude.stdout, /Options for usage/);
    assert.match(claude.stdout, /Options for all commands/);
    assert.match(claude.stdout, /--model <id>/);
    assert.match(claude.stdout, /--opus <id>/);
    assert.match(claude.stdout, /--sonnet <id>/);
    assert.match(claude.stdout, /--haiku <id>/);
    assert.match(claude.stdout, /--subagent <id>/);
    assert.match(claude.stdout, /Pin the Sonnet tier slot/);
    assert.match(claude.stdout, /--plain/);
    assert.match(claude.stdout, /Plain text summary/);
    assert.match(claude.stdout, /--home <path>/);
    assert.match(claude.stdout, /--data-dir <path>/);
    assert.match(claude.stdout, /Override HOME/);
    assert.doesNotMatch(claude.stdout, /--routing-preference/);
    assert.doesNotMatch(claude.stdout, /--anthropic-api-key/);

    const codex = await runCli(["codex", "help"]);
    assert.equal(codex.code, 0, codex.stderr);
    assert.match(codex.stdout, /Options for on/);
    assert.match(codex.stdout, /default: auto/);
    assert.doesNotMatch(codex.stdout, /--anthropic-api-key/);
    assert.doesNotMatch(codex.stdout, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(codex.stdout, /--openai-api-key/);
    assert.match(codex.stdout, /GPT turns are paid by Codex's own sign-in/);
    assert.match(codex.stdout, /else by an OpenAI Provider Key on your Fireworks account/);
    assert.doesNotMatch(codex.stdout, /chatgpt-login/);

    const pi = await runCli(["pi", "help"]);
    assert.equal(pi.code, 0, pi.stderr);
    assert.match(pi.stdout, /Alias for --settings-path/);

    const cursor = await runCli(["cursor", "help"]);
    assert.equal(cursor.code, 0, cursor.stderr);
    assert.match(cursor.stdout, /Quit Cursor before on\/off/);
    assert.match(cursor.stdout, /Only Fireworks models work while Nexus CLI is on/);
    assert.match(cursor.stdout, /built-ins are hidden/);

    const deepseek = await runCli(["deepseek", "help"]);
    assert.equal(deepseek.code, 0, deepseek.stderr);
    assert.match(deepseek.stdout, /default: auto/);
  });

  test("fireconnect <harness> help matches fireconnect help <harness>", async () => {
    for (const harness of ["claude", "codex", "pi"]) {
      const topicFirst = await runCli([harness, "help"]);
      const helpFirst = await runCli(["help", harness]);
      assert.equal(topicFirst.code, 0, topicFirst.stderr);
      assert.equal(helpFirst.code, 0, helpFirst.stderr);
      assert.equal(topicFirst.stdout, helpFirst.stdout);
    }
  });
});

describe("fireconnect version", () => {
  test("supports --version flag", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const result = await runCli(["--version"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), `v${pkg.version}`);
  });

  test("supports -V flag", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const result = await runCli(["-V"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), `v${pkg.version}`);
  });

  test("rejects version subcommand", async () => {
    const result = await runCli(["version"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unknown command: version/);
  });

  test("supports --version --json", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const { code, stderr, json } = await runCliJson(["--version", "--json"]);
    assert.equal(code, 0, stderr);
    assert.equal(json.version, pkg.version);
  });

  test("supports -V --json", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const { code, stderr, json } = await runCliJson(["-V", "--json"]);
    assert.equal(code, 0, stderr);
    assert.equal(json.version, pkg.version);
  });
});

describe("unexpected input guidance", () => {
  test("harness errors point to harness help", async () => {
    const result = await runCli(["claude", "on", "--not-a-flag"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unknown argument: --not-a-flag/);
    assert.match(result.stderr, /Run: nexus claude help/);

    const wrongContext = await runCli(["pi", "on", "--force"]);
    assert.notEqual(wrongContext.code, 0);
    assert.match(wrongContext.stderr, /--force is only supported/);
    assert.match(wrongContext.stderr, /Run: nexus pi help/);
  });

  test("global errors point to global help", async () => {
    const result = await runCli(["not-a-command"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unknown command: not-a-command/);
    assert.match(result.stderr, /Run: nexus help/);
  });
});

describe("fireconnect claude on", () => {
  test("fw_ leaves tier slots native and registers serverless models in modelPicker", async () => {
    await withTempHome("on-fw", async (home) => {
      seedOnCatalog(home);
      const result = await runCli(
        ["claude", "on", "--api-key", FW_CLAUDE_KEY],
        { home, env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } },
      );
      assert.equal(result.code, 0, result.stderr);

      const settings = await readClaudeSettings(home);
      // Main is native (unpinned): no top-level model and no legacy main env.
      assert.equal(settings.model, "auto[1m]");
      assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
      assertClaudeNativeTierSlots(settings);
      assertClaudeRegisterablePicker(settings, {
        includes: ["auto[1m]", "glm-latest[1m]"],
        excludes: ["firerouter[1m]"],
      });
      assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
      assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined);
      for (const key of ["DISABLE_TELEMETRY", "DO_NOT_TRACK", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
        assert.equal(Object.hasOwn(settings.env, key), false, key);
      }
      assert.equal(settings.env.ENABLE_TOOL_SEARCH, "true");
      assert.equal(Object.hasOwn(settings.env, "CLAUDE_CODE_AUTO_MODE_SERVER"), false);
      assert.equal(Object.hasOwn(settings.env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
    });
  });

  test("rejects an fpk_ --api-key", async () => {
    await withTempHome("on-fpk", async (home) => {
      const result = await runCli(
        ["claude", "on", "--api-key", FPK_KEY],
        { home, env: { ...NO_ENV_KEY, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Fire Pass keys \(fpk_\.\.\.\) are no longer supported\. Run `nexus login` to sign in\./);
    });
  });

  test("treats a stored fpk_ key as missing and points to login", async () => {
    await withTempHome("on-fpk-stored", async (home) => {
      await seedKeychainConfig(home, FPK_KEY);
      const result = await runCli(["opencode", "on"], { home, env: NO_ENV_KEY });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Fireworks API key found[\s\S]*nexus login/);
    });
  });

  test("rejects an fpk_ FIREWORKS_API_KEY with the login hint", async () => {
    await withTempHome("on-fpk-env", async (home) => {
      const result = await runCli(
        ["opencode", "on"],
        { home, env: { FIREWORKS_API_KEY: FPK_KEY } },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /no longer supported\. Run `nexus login`/);
    });
  });

  test("uses FIREWORKS_API_KEY when settings only have native Anthropic key", async () => {
    await withTempHome("on-skant", async (home) => {
      seedOnCatalog(home);
      await writeNativeAnthropicSettings(home);
      const result = await runCli(["claude", "on"], {
        home,
        env: {
          FIREWORKS_API_KEY: FW_CLAUDE_KEY,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
        },
      });
      assert.equal(result.code, 0, result.stderr);

      const settings = await readClaudeSettings(home);
      assert.equal(settings.apiKeyHelper, undefined);
      assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, new RegExp(`X-Fireworks-Api-Key: ${FW_CLAUDE_KEY}`));
      assert.equal(settings.model, "auto[1m]");
      assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
      assertClaudeNativeTierSlots(settings);
      assertClaudeRegisterablePicker(settings, { includes: ["auto[1m]"], excludes: ["firerouter[1m]"] });
      assert.equal(settings.env.ANTHROPIC_API_KEY, SK_ANT_KEY);
      assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
      assert.equal(settings.env.ANTHROPIC_BASE_URL, FIREWORKS_INFERENCE_URL);
    });
  });

  test("re-run: FIREWORKS_API_KEY env beats stored key", async () => {
    await withTempHome("reon-stored", async (home) => {
      seedOnCatalog(home);
      const first = await runCli(
        ["claude", "on", "--api-key", ALT_FW_KEY],
        { home, env: { ...NO_ENV_KEY, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } },
      );
      assert.equal(first.code, 0, first.stderr);
      const result = await runCli(["claude", "on"], {
        home,
        env: {
          FIREWORKS_API_KEY: FW_CLAUDE_KEY,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
        },
      });
      assert.equal(result.code, 0, result.stderr);

      const settings = await readClaudeSettings(home);
      assert.equal(settings.apiKeyHelper, undefined);
      assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, new RegExp(`X-Fireworks-Api-Key: ${FW_CLAUDE_KEY}`));
      assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    });
  });
});

describe("fireconnect opencode on", () => {
  test("fw_ uses auto as default model", async () => {
    await withTempHome("on-fw-oc", async (home) => {
      seedOnCatalog(home);
      const result = await runCli(
        ["opencode", "on", "--api-key", FW_CLAUDE_KEY],
        { home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = await readOpencodeConfig(home);
      assert.equal(config.model, `fireworks-ai/auto`);
      // Bare `auto` gets a synthesized catalog entry (name/limits only — no
      // per-Mtok cost, unlike the router entries).
      assert.deepEqual(
        config.provider["fireworks-ai"].models["auto"],
        {
          name: "Auto",
          limit: { context: 1_048_575, output: 131_072 },
          modalities: { input: ["text", "image"] },
        },
      );
    });
  });

});

describe("fireconnect model list", () => {
  test("FIREWORKS_API_KEY env beats globally stored key", async () => {
    const gateway = await startKeyRecordingGateway();
    try {
      await withTempHome("ml-env", async (home) => {
        await writeGlobalConfig(home, { apiKey: FW_CLAUDE_KEY });
        await runCli(
          ["model", "list", "--refresh", "--json"],
          { home, env: { FIREWORKS_API_KEY: ALT_FW_KEY, NEXUS_GATEWAY_URL: gateway.url } },
        );
      });
      assert.ok(gateway.keys.length > 0, "expected a catalog request");
      assert.ok(gateway.keys.every((key) => key === ALT_FW_KEY), gateway.keys.join(","));
    } finally {
      gateway.server.close();
    }
  });

  test("uses the globally stored key and ignores harness-only keys", async () => {
    await withTempHome("ml-global-key", async (home) => {
      await writeOpencodeConfig(home, FW_CLAUDE_KEY);
      const missing = await runCli(
        ["model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /No Fireworks API key found/);

      await writeGlobalConfig(home, { apiKey: FW_CLAUDE_KEY });
      seedServerlessCatalogCache(home, [{
        id: "accounts/fireworks/models/cached-model",
        shortId: "cached-model",
        displayName: "Cached Model",
        kind: "serverless",
      }]);
      const { code, stderr, json } = await runCliJson(
        ["model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(code, 0, stderr);
      assert.ok(json.models.some((entry) => entry.shortId === "cached-model"));
    });
  });

  test("never lists FireRouter rows, even when the catalog returns them", async () => {
    await withTempHome("ml-no-firerouter-", async (home) => {
      await writeGlobalConfig(home, { apiKey: FW_CLAUDE_KEY });
      seedServerlessCatalogCache(home, [
        {
          id: "accounts/fireworks/models/cached-model",
          shortId: "cached-model",
          displayName: "Cached Model",
          kind: "serverless",
        },
        {
          id: "accounts/fireworks/routers/firerouter",
          shortId: "firerouter",
          displayName: "FireRouter",
          kind: "serverless",
        },
      ]);
      const { code, stderr, json } = await runCliJson(
        ["model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(code, 0, stderr);
      assert.ok(json.models.some((entry) => entry.shortId === "cached-model"));
      assert.ok(
        !json.models.some((entry) => entry.shortId?.startsWith("firerouter") || entry.id?.includes("firerouter")),
        JSON.stringify(json.models.map((entry) => entry.shortId)),
      );
    });
  });

  test("ignores a globally stored fpk_ key", async () => {
    await withTempHome("ml-global-fpk", async (home) => {
      await writeGlobalConfig(home, { apiKey: FPK_KEY });
      const result = await runCli(
        ["model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Fireworks API key found/);
    });
  });

  test("--json --refresh reports stale when the gateway is unreachable", async () => {
    await withTempHome("ml-refresh-stale", async (home) => {
      seedServerlessCatalogCache(home, [{
        id: "accounts/fireworks/models/cached-model",
        shortId: "cached-model",
        displayName: "Cached Model",
        kind: "serverless",
      }]);

      const { code, stderr, json } = await runCliJson(
        ["model", "list", "--api-key", FW_CLAUDE_KEY, "--refresh", "--json"],
        {
          home,
          env: {
            ...NO_ENV_KEY,
            NEXUS_GATEWAY_URL: "http://127.0.0.1:9",
          },
        },
      );

      assert.equal(code, 0, stderr);
      assert.equal(json.source, "stale");
      assert.match(json.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(json.models.some((entry) => entry.shortId === "cached-model"));
    });
  });

});

describe("fireconnect <harness> status", () => {
  test("fw_ key gets Claude defaults", async () => {
    await withTempHome("status-fw", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const { json } = await runCliJson(["claude", "status", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.defaults.main, "claude-default");
      assert.equal(json.defaults.opus, "claude-default");
      assert.equal(json.defaults.sonnet, "claude-default");
      assert.equal(json.defaults.haiku, "claude-default");
    });
  });

  test("ignores sk-ant tokens in Claude settings for key type", async () => {
    await withTempHome("status-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const { json } = await runCliJson(["claude", "status", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.provider, "default");
      assert.equal(json.defaults.sonnet, "claude-default");
    });
  });

  test("opencode resolves env-ref key", async () => {
    await withTempHome("status-envref", async (home) => {
      await writeOpencodeConfig(home, OPENCODE_API_KEY_ENV_REF);
      const { json } = await runCliJson(
        ["opencode", "status", "--json"],
        { home, env: { FIREWORKS_API_KEY: FW_CLAUDE_KEY } },
      );
      assert.equal(json.hasAuthToken, true);
      assert.equal(json.defaults.main, "auto");
    });
  });
});

describe("unsupported model mutation commands", () => {
  for (const subcommand of ["select", "reset", "add"]) {
    test(`model ${subcommand} uses generic harness guidance`, async () => {
      await withTempHome(`removed-model-${subcommand}`, async (home) => {
        const result = await runCli(["opencode", "model", subcommand], { home });
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, new RegExp(`Unknown harness command: model ${subcommand}`));
        assert.match(result.stderr, /Run: nexus opencode help/);
      });
    });
  }

  test("--slot is an ordinary unknown option", async () => {
    await withTempHome("removed-claude-slot", async (home) => {
      const result = await runCli(
        ["claude", "on", "--slot", "sonnet"],
        { home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unknown argument: --slot/);
      assert.match(result.stderr, /Run: nexus claude help/);
    });
  });
});
