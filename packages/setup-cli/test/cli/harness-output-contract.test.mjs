import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCli, withTempHome } from "../helpers.mjs";
import {
  printClaudeModelManagementHints,
  printClaudeModelActivationHint,
  printCodexRestartHint,
  printDeepseekRestartHint,
  printModelsAdded,
  printOpenCodeRestartHint,
  printPiRestartHint,
} from "../../lib/cli/messages.mjs";
import { symbols } from "../../lib/ui/style.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";

function nonemptyLines(output) {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

describe("compact harness command output", () => {
  it("prints concise Claude model management commands", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printClaudeModelManagementHints();
    } finally {
      console.log = original;
    }
    const output = lines.join("\n");
    assert.match(output, /Manage models/);
    assert.match(output, /nexus model list/);
    // `nexus claude <flag>` and `nexus claude on <flag>` are both
    // valid; the hints print the shorter form.
    assert.match(output, /nexus claude --model <id>/);
    // FireRouter stays discoverable via --model help, not a standing hint row.
    assert.doesNotMatch(output, /--model firerouter/);
    assert.doesNotMatch(output, /--opus|--interactive/);
    assert.doesNotMatch(output, /Also in your model list/);
  });

  it("prints the two FireRouter model-list cases", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printModelsAdded([
        "accounts/fireworks/routers/glm-latest",
        "accounts/fireworks/routers/firerouter",
      ]);
      printModelsAdded(["accounts/fireworks/routers/glm-latest"]);
      printClaudeModelActivationHint();
      printCodexRestartHint();
      printPiRestartHint();
      printDeepseekRestartHint();
      printOpenCodeRestartHint();
    } finally {
      console.log = original;
    }
    assert.equal(lines[0], "Also in your model list: glm-latest, firerouter");
    assert.equal(lines[1], "Also in your model list: glm-latest");
    assert.equal(lines[2], "Restart Claude Code to use the new setup.");
    assert.match(lines[3], /Quit & reopen the ChatGPT app/);
    assert.match(lines[4], /^To resume existing Codex sessions with Fireworks:\n/);
    assert.match(lines[4], /^ {2}codex resume <id> -c model_provider="fireworks-ai"/m);
    assert.match(
      lines[4],
      /^ChatGPT app threads started on OpenAI stay on OpenAI\. Start a new thread to use Fireworks models\.$/m,
    );
    assert.equal(lines[5], "Restart Pi to use the new setup.");
    assert.equal(lines[6], "Restart DeepSeek Harness to use the new setup.");
    assert.equal(lines[7], "Restart OpenCode to use the new setup.");
  });

  it("tells Codex off users how to reopen ChatGPT app threads started on Fireworks", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printCodexRestartHint({ resume: false });
    } finally {
      console.log = original;
    }
    assert.match(lines[0], /Quit & reopen the ChatGPT app/);
    assert.equal(lines[1], "Start Codex again to use the new setup.");
    assert.equal(
      lines[2],
      "ChatGPT app threads started on Fireworks won't open until you run `nexus codex on` again.",
    );
    assert.doesNotMatch(lines.join("\n"), /codex resume/);
  });

  it("prints outcome, FireRouter help, and one apply action for routine on", async () => {
    await withTempHome("compact-on-", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--model", "deepseek-v4-flash"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "fw_compact_output_key",
            ANTHROPIC_API_KEY: "",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = nonemptyLines(result.stdout);
      // Success line + restart hint only — no FireRouter advertisement.
      assert.equal(lines.length, 2, result.stdout);
      assert.match(lines[0], /OpenCode → Fireworks · deepseek-v4-flash/);
      assert.equal(lines[1], "Restart OpenCode to use the new setup.");
      assert.doesNotMatch(result.stdout, /Next →|Revert anytime|Tip:|API key written/);
      assert.doesNotMatch(result.stdout, /FireRouter/);
    });
  });

  it("does not claim FireRouter is on when only registered in the catalog", async () => {
    await withTempHome("compact-catalog-only-", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--api-key", "fw_compact_output_key"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "sk-ant-configured",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /OpenCode → Fireworks · auto/);
      // A plain `on` never advertises FireRouter — even with a key present.
      assert.doesNotMatch(result.stdout, /FireRouter/);
    });
  });

  it("rejects a firerouter model selection with no connected output", async () => {
    await withTempHome("compact-firerouter-", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--model", "firerouter"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "fw_compact_output_key",
            ANTHROPIC_API_KEY: "sk-ant-configured",
          },
        },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--model firerouter is a FireRouter route, which is no longer supported/);
      assert.doesNotMatch(result.stdout, /OpenCode → Fireworks/);
    });
  });

  it("warns that --routing-preference is deprecated and connects without it", async () => {
    await withTempHome("compact-routing-pref-", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--routing-preference", "balanced"],
        { home, env: { FIREWORKS_API_KEY: "fw_compact_output_key" } },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stderr,
        /--routing-preference is deprecated and has no effect: FireRouter routes are no longer supported\./,
      );
      const lines = nonemptyLines(result.stdout);
      assert.equal(lines.length, 2, result.stdout);
      assert.match(lines[0], /OpenCode → Fireworks · auto/);
      assert.doesNotMatch(result.stdout, /Routing:/);
    });
  });

  it("uses Claude default tier slots when BYOK is configured without explicit flags", async () => {
    await withTempHome("compact-claude-byok-", async (home) => {
      await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-configured" });
      const result = await runCli(
        ["claude", "on", "--api-key", "fw_compact_output_key"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = nonemptyLines(result.stdout);
      assert.equal(lines[0], `${symbols.ok} Claude Code → Fireworks · auto`);
      assert.match(result.stdout, /Model picker/);
      assert.match(result.stdout, /Anthropic model slots.*unchanged/);
      assert.match(result.stdout, /Fireworks catalog.*appended/);
      assert.doesNotMatch(result.stdout, /Opus\s+→/);
      assert.doesNotMatch(result.stdout, /FireRouter is on/);
      assert.doesNotMatch(result.stdout, /no Anthropic key found/);
      assert.match(result.stdout, /Restart Claude Code to use the new setup/);
    });
  });

  it("rejects Codex firerouter selections, bare and compound", async () => {
    await withTempHome("compact-codex-firerouter-", async (home) => {
      for (const model of ["firerouter", "firerouter/sol"]) {
        const result = await runCli(
          ["codex", "on", "--model", model, "--api-key", "fw_compact_output_key"],
          {
            home,
            env: {
              FIREWORKS_API_KEY: "",
              ANTHROPIC_API_KEY: "sk-ant-configured",
            },
          },
        );
        assert.notEqual(result.code, 0, model);
        assert.match(result.stderr, /is a FireRouter route, which is no longer supported/, model);
        assert.doesNotMatch(result.stdout, /Codex → Fireworks/, model);
      }
    });
  });

  it("keeps Azure output to outcome, endpoint, and apply action", async () => {
    await withTempHome("compact-azure-", async (home) => {
      const result = await runCli(
        [
          "opencode", "on", "--azure",
          "--base-url", "https://demo.services.ai.azure.com",
          "--api-key", "az_demo",
        ],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = nonemptyLines(result.stdout);
      assert.equal(lines.length, 3, result.stdout);
      assert.match(lines[0], /OpenCode → Fireworks on Microsoft Foundry · FW-GLM-5.2/);
      assert.match(lines[1], /Endpoint: https:\/\/demo\.services\.ai\.azure\.com\/openai\/v1/);
      assert.equal(lines[2], "Restart OpenCode to use the new setup.");
      assert.match(result.stdout, /openai\/v1\n\nRestart OpenCode/);
    });
  });
});
