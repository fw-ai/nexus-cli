import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { globalConfigPath } from "../../lib/config/global-config.mjs";
import { codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { runCli, withTempHome } from "../helpers.mjs";

describe("harness option validation", () => {
  const rejects = async (home, args, pattern) => {
    const result = await runCli(args, {
      home,
      env: {
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    });
    assert.notEqual(result.code, 0, `${args.join(" ")} should fail`);
    assert.match(result.stderr, pattern);
  };

  it("rejects Azure and provider flags that the selected harness cannot apply", async () => {
    await withTempHome("option-azure-", async (home) => {
      await rejects(home, ["claude", "on", "--azure"], /Claude does not support Azure mode/);
      await rejects(home, ["codex", "on", "--azure"], /Codex no longer supports Azure\/Foundry/);
      await rejects(home, ["pi", "on", "--provider", "azure"], /--provider is configure-only/);
      await rejects(
        home,
        ["codex", "on", "--base-url", "https://example.services.ai.azure.com"],
        /--base-url on this harness requires --azure/,
      );
    });
  });

  it("rejects firerouter* model patterns on every harness", async () => {
    await withTempHome("option-firerouter-reject-", async (home) => {
      for (const args of [
        ["codex", "on", "--model", "firerouter"],
        ["codex", "on", "--model", "firerouter/opus"],
        ["claude", "on", "--model", "firerouter"],
        ["claude", "on", "--model", "accounts/fireworks/routers/firerouter"],
        ["claude", "on", "--opus", "firerouter/opus"],
        ["opencode", "on", "--model", "firerouter/kimi-k3"],
        ["pi", "on", "--model", "firerouter-2"],
        ["cursor", "on", "--model", "firerouter/kimi-k3"],
        ["vscode", "on", "--model", "firerouter"],
        ["deepseek", "on", "--model", "firerouter"],
        ["copilot-cli", "on", "--model", "firerouter"],
        ["copilot-app", "on", "--model", "firerouter"],
        ["claude-desktop", "on", "--model", "firerouter"],
      ]) {
        await rejects(home, args, /is no longer supported/);
      }
    });
  });

  it("refuses provider-key flags on every harness command and points to nexus auto", async () => {
    await withTempHome("option-provider-keys-", async (home) => {
      await rejects(
        home,
        ["pi", "on", "--anthropic-api-key", "sk-ant-test"],
        /Save the key once with `nexus auto --anthropic-api-key <key>`, then run `nexus pi` again/,
      );
      await rejects(
        home,
        ["pi", "status", "--openai-api-key", "sk-openai-test"],
        /nexus auto --openai-api-key <key>/,
      );
      await rejects(
        home,
        ["claude", "on", "--anthropic-api-key", "sk-ant-test"],
        /Claude Code's own login covers Claude turns/,
      );
    });
  });

  it("rejects BYOK flags a harness cannot forward", async () => {
    await withTempHome("option-firerouter-capability-", async (home) => {
      // FireRouter routes are rejected before BYOK forwarding is considered.
      await rejects(
        home,
        ["cursor", "on", "--model", "firerouter/kimi-k3", "--anthropic-api-key", "sk-ant-test"],
        /is no longer supported/,
      );
      await rejects(
        home,
        ["cursor", "on", "--model", "firerouter/kimi-k3", "--openai-api-key", "sk-openai-test"],
        /is no longer supported/,
      );
    });
  });

  it("refuses --openai-api-key on codex and points to Codex's own sign-in", async () => {
    await withTempHome("option-codex-openai-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      const result = await runCli(
        [
          "codex", "on",
          "--api-key", "fw_test_key_12345",
          "--model", "firerouter",
          "--openai-api-key", "sk-proj-codex-flag-12345",
        ],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            SHELL: "/bin/bash",
            ZSH_VERSION: "",
            BASH_VERSION: "5",
          },
        },
      );
      assert.notEqual(result.code, 0);
      // The FireRouter model is rejected before the BYOK flag is considered.
      assert.match(result.stderr, /is no longer supported/);
      assert.equal(existsSync(codexConfigPath(home)), false);
      const globalConfig = existsSync(globalConfigPath(home))
        ? JSON.parse(await readFile(globalConfigPath(home), "utf8"))
        : {};
      assert.equal(globalConfig.openaiApiKey, undefined);
    });
  });

  it("refuses --anthropic-api-key on codex and points to an Anthropic Provider Key", async () => {
    await withTempHome("option-codex-anthropic-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      const result = await runCli(
        [
          "codex", "on",
          "--api-key", "fw_test_key_12345",
          "--model", "firerouter/opus",
          "--anthropic-api-key", "sk-ant-codex-flag-12345",
        ],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            SHELL: "/bin/bash",
            ZSH_VERSION: "",
            BASH_VERSION: "5",
          },
        },
      );
      assert.notEqual(result.code, 0);
      // The FireRouter model is rejected before the BYOK flag is considered.
      assert.match(result.stderr, /is no longer supported/);
      assert.equal(existsSync(codexConfigPath(home)), false);
      const globalConfig = existsSync(globalConfigPath(home))
        ? JSON.parse(await readFile(globalConfigPath(home), "utf8"))
        : {};
      assert.equal(globalConfig.anthropicApiKey, undefined);
    });
  });

  it("rejects a Claude FireRouter selection instead of connecting", async () => {
    await withTempHome("option-claude-firerouter-", async (home) => {
      await rejects(
        home,
        ["claude", "on", "--api-key", "fw_test_key_12345", "--model", "firerouter"],
        /--model firerouter is no longer supported\. Use --model auto instead\./,
      );
    });
  });

  it("scopes Claude tier-slot flags to claude on", async () => {
    await withTempHome("option-specific-", async (home) => {
      await rejects(home, ["pi", "on", "--force"], /--force is only supported/);
      await rejects(home, ["cursor", "on", "--mode", "composer"], /Unknown argument: --mode/);
      await rejects(home, ["cursor", "on", "--slot", "main"], /Unknown argument: --slot/);
      await rejects(home, ["pi", "on", "--opus", "glm-latest"], /--opus.*apply only to `nexus claude on`/);
      await rejects(home, ["cursor", "on", "--subagent", "glm-latest"], /--subagent.*apply only to `nexus claude on`/);
      await rejects(home, ["claude", "status", "--sonnet", "glm-latest"], /--opus.*apply only to `nexus claude on`/);
      await rejects(home, ["opencode", "on", "--non-interactive"], /applies only to .*claude on/);
      await rejects(home, ["opencode", "on", "--interactive"], /applies only to .*claude on/);
      await rejects(
        home,
        ["claude", "on", "--interactive", "--non-interactive"],
        /cannot be used together/,
      );
      await rejects(
        home,
        ["claude", "on", "--interactive", "--opus", "glm-latest"],
        /--interactive is not supported/,
      );
      await rejects(
        home,
        ["claude", "on", "--interactive"],
        /--interactive is not supported/,
      );
    });
  });

  it("rejects usage, JSON, and path options where they are ignored", async () => {
    await withTempHome("option-command-scope-", async (home) => {
      await rejects(home, ["pi", "status", "--session", "abc"], /applies only to .*claude usage/);
      await rejects(home, ["opencode", "on", "--json"], /--json is supported by/);
      await rejects(home, ["claude", "on", "--refresh"], /--refresh applies only to .*model list/);
      await rejects(home, ["codex", "status", "--db-path", "/tmp/state.vscdb"], /--db-path is supported only by Cursor/);
      await rejects(home, ["cursor", "status", "--config-path", "/tmp/config"], /--config-path is supported only by/);
      await rejects(home, ["vscode", "status", "--settings-path", "/tmp/settings"], /--settings-path is supported only by/);
    });
  });

  it("points the retired claude live command at the status line, even with --session", async () => {
    await withTempHome("option-live-session-", async (home) => {
      for (const args of [["claude", "live"], ["claude", "live", "--session", "abc"]]) {
        const live = await runCli(args, {
          home,
          env: { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
        });
        assert.equal(live.code, 0, `${args.join(" ")} should exit cleanly`);
        assert.match(live.stderr, /`nexus claude live` was removed: Claude Code's status line shows the routed model/);
        assert.match(live.stderr, /nexus claude usage/);
      }
      await rejects(home, ["codex", "usage", "--session", "abc"], /--session applies only to `nexus claude usage`\./);
    });
  });
});
