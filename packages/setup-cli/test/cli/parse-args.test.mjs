import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../../lib/cli/parse-args.mjs";

describe("parseCli", () => {
  it("routes bare invocation to the launcher", () => {
    const parsed = parseCli([]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "launcher");
  });

  it("keeps explicit help as help, not the launcher", () => {
    const parsed = parseCli(["help"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "help");
  });

  it("parses global configure", () => {
    const parsed = parseCli(["configure", "--provider", "azure", "--base-url", "https://x.example.com"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "configure");
    assert.equal(parsed.ctx.provider, "azure");
  });

  it("parses global update", () => {
    const parsed = parseCli(["update"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "update");
  });

  it("parses upgrade as an alias for update", () => {
    const parsed = parseCli(["upgrade"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "update");
  });

  it("rejects positional arguments after update", () => {
    assert.throws(() => parseCli(["update", "now"]), /update does not accept positional arguments/);
  });

  it("rejects positional arguments after upgrade", () => {
    assert.throws(() => parseCli(["upgrade", "now"]), /upgrade does not accept positional arguments/);
  });

  it("parses hidden finalize-install (install.sh / upgrade shared path)", () => {
    const parsed = parseCli(["finalize-install"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "finalize-install");
  });

  it("parses --version flag", () => {
    const parsed = parseCli(["--version"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
  });

  it("parses -V flag", () => {
    const parsed = parseCli(["-V"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
  });

  it("parses --version with trailing --json", () => {
    const parsed = parseCli(["--version", "--json"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses -V with trailing --json", () => {
    const parsed = parseCli(["-V", "--json"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses --json before --version", () => {
    const parsed = parseCli(["--json", "--version"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses global model list", () => {
    const parsed = parseCli(["model", "list", "--search", "glm"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "model");
    assert.equal(parsed.modelSubcommand, "list");
    assert.equal(parsed.ctx.search, "glm");
    assert.equal(parsed.ctx.refresh, false);
  });

  it("parses model list --refresh", () => {
    const parsed = parseCli(["model", "list", "--refresh"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "model");
    assert.equal(parsed.modelSubcommand, "list");
    assert.equal(parsed.ctx.refresh, true);
  });

  it("parses models as an alias for model list", () => {
    const parsed = parseCli(["models", "--search", "glm"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "model");
    assert.equal(parsed.modelSubcommand, "list");
    assert.equal(parsed.ctx.search, "glm");
  });

  it("rejects positional arguments after models", () => {
    assert.throws(
      () => parseCli(["models", "list"]),
      /nexus models does not accept positional arguments/,
    );
  });

  it("parses bare harness as on", () => {
    const parsed = parseCli(["claude"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.verb, "on");
  });

  it("aliases chatgpt to the codex harness", () => {
    const parsed = parseCli(["chatgpt", "on"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "codex");
    assert.equal(parsed.route.verb, "on");
  });

  it("aliases bare chatgpt to codex on", () => {
    const parsed = parseCli(["chatgpt"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "codex");
    assert.equal(parsed.route.verb, "on");
  });

  it("passes the typed chatgpt help topic through for display", () => {
    const parsed = parseCli(["help", "chatgpt"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "help");
    assert.equal(parsed.helpTopic, "chatgpt");
  });

  it("parses harness verb", () => {
    const parsed = parseCli(["opencode", "status", "--json"]);
    assert.equal(parsed.route.harnessId, "opencode");
    assert.equal(parsed.route.verb, "status");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses harness usage with session selector", () => {
    const parsed = parseCli(["claude", "usage", "--session", "9b86", "--json"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.verb, "usage");
    assert.equal(parsed.ctx.session, "9b86");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses harness usage with last-n selector", () => {
    const parsed = parseCli(["claude", "usage", "--last-n", "3", "-v"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.verb, "usage");
    assert.equal(parsed.ctx.lastN, "3");
    assert.equal(parsed.ctx.verbose, true);
  });

  it("parses harness usage with plain summary flag", () => {
    const parsed = parseCli(["claude", "usage", "--last-n", "3", "--plain"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.verb, "usage");
    assert.equal(parsed.ctx.lastN, "3");
    assert.equal(parsed.ctx.plain, true);
  });

  it("parses claude live", () => {
    const live = parseCli(["claude", "live"]);
    assert.equal(live.kind, "harness");
    assert.equal(live.route.harnessId, "claude");
    assert.equal(live.route.verb, "live");
    assert.equal(live.route.noun, "");
  });

  it("rejects claude live kill", () => {
    assert.throws(
      () => parseCli(["claude", "live", "kill"]),
      /does not accept positional arguments/,
    );
  });

  it("parses --model firerouter and the anthropic key flag", () => {
    const parsed = parseCli([
      "claude", "on", "--model", "firerouter",
      "--anthropic-api-key", "sk-ant-test",
    ]);
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.ctx.main, "firerouter");
    assert.equal(parsed.ctx.anthropicKey, "sk-ant-test");
  });

  it("parses Claude's non-interactive onboarding opt-out", () => {
    const parsed = parseCli(["claude", "on", "--non-interactive"]);
    assert.equal(parsed.ctx.onboardingMode, "skip");
  });

  it("parses Claude's reusable interactive model wizard", () => {
    const parsed = parseCli(["claude", "on", "--interactive"]);
    assert.equal(parsed.ctx.onboardingMode, "prompt");
  });

  it("rejects contradictory onboarding modes while parsing", () => {
    assert.throws(
      () => parseCli(["claude", "on", "--interactive", "--non-interactive"]),
      /cannot be used together/,
    );
  });

  it("rejects --non-interactive on global commands", () => {
    assert.throws(
      () => parseCli(["status", "--non-interactive"]),
      /applies only to `nexus claude on`/,
    );
  });

  it("rejects --interactive on global commands", () => {
    assert.throws(
      () => parseCli(["status", "--interactive"]),
      /applies only to `nexus claude on`/,
    );
  });

  it("rejects retired flags and points at the current spelling", () => {
    const renamed = [
      ["--main", "--model"],
      ["--router", "--model auto"],
      ["--anthropic-key", "--anthropic-api-key"],
      ["--last_n", "--last-n"],
    ];
    for (const [flag, replacement] of renamed) {
      assert.throws(
        () => parseCli(["claude", "on", flag, "x"]),
        new RegExp(`Unknown argument: ${flag.replace(/[-]/g, "\\-")}\\. Use ${replacement.replace(/[-]/g, "\\-")} instead`),
      );
    }
  });

  it("parses --openai-api-key for OpenAI frontier models", () => {
    const parsed = parseCli(["codex", "on", "--model", "firerouter", "--openai-api-key", "sk-proj-test"]);
    assert.equal(parsed.ctx.openaiKey, "sk-proj-test");
    assert.equal(parsed.ctx.openaiKeyFromFlag, true);
  });

  it("accepts the deprecated --routing-preference flag, consumes its value, and marks it", () => {
    const parsed = parseCli(["opencode", "on", "--model", "firerouter", "--routing-preference", "balanced"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.ctx.routingPreferenceDeprecated, true);
    assert.equal(parsed.ctx.main, "firerouter");
    assert.equal(parseCli(["opencode", "on"]).ctx.routingPreferenceDeprecated, false);
    assert.throws(() => parseCli(["claude", "on", "--routing-preference"]), /requires a value/);
  });

  it("parses login flags (--force, --with-token, --paste)", () => {
    const parsed = parseCli(["login", "--paste", "--force"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "login");
    assert.equal(parsed.ctx.paste, true);
    assert.equal(parsed.ctx.force, true);
    assert.equal(parsed.ctx.withToken, false);
  });

  it("parses login --account for enterprise SSO", () => {
    const parsed = parseCli(["login", "--account", "my-company"]);
    assert.equal(parsed.ctx.account, "my-company");
    assert.throws(() => parseCli(["login", "--account"]), /requires a value/);
  });

  it("parses Anthropic key export flags", () => {
    const parsed = parseCli(["key", "export", "--anthropic", "--stored-only"]);
    assert.equal(parsed.ctx.anthropic, true);
    assert.equal(parsed.ctx.storedOnly, true);
  });

  it("rejects every harness-level model subcommand", () => {
    for (const subcommand of ["list", "select", "reset", "add"]) {
      assert.throws(
        () => parseCli(["claude", "model", subcommand]),
        /Unknown harness command.*Run: nexus claude help/,
      );
    }
  });

  it("rejects removed set verb", () => {
    assert.throws(() => parseCli(["claude", "set", "--model", "x"]), /Unknown harness command: set/);
  });

  it("routes harness help to global help with topic", () => {
    const parsed = parseCli(["claude", "help"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "help");
    assert.equal(parsed.helpTopic, "claude");
  });

  it("routes fireconnect help <harness> to the same harness topic", () => {
    const parsed = parseCli(["help", "claude"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "help");
    assert.equal(parsed.helpTopic, "claude");
  });

  it("routes harness --help to that harness topic", () => {
    const parsed = parseCli(["opencode", "--help"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "help");
    assert.equal(parsed.helpTopic, "opencode");
  });

  it("rejects unknown top-level command", () => {
    assert.throws(() => parseCli(["on"]), /Unknown command: on/);
  });

  it("rejects unsupported global model subcommands", () => {
    assert.throws(
      () => parseCli(["model", "select"]),
      /Unexpected model subcommand: select.*Run: nexus help/,
    );
  });
});

describe("parseCli typo suggestions", () => {
  it("suggests the nearest command", () => {
    assert.throws(() => parseCli(["cluade", "on"]), /Did you mean: claude\?/);
    assert.throws(() => parseCli(["confgure"]), /Did you mean: configure\?/);
  });

  it("suggests harness aliases, which help advertises as top-level commands", () => {
    assert.throws(() => parseCli(["chatgtp", "on"]), /Did you mean: chatgpt\?/);
  });

  it("suggests the nearest flag", () => {
    assert.throws(() => parseCli(["claude", "on", "--serach", "x"]), /Did you mean: --search\?/);
  });

  it("suggests the nearest harness verb", () => {
    assert.throws(() => parseCli(["claude", "statsu"]), /Did you mean: status\?/);
    assert.throws(() => parseCli(["modle", "list"]), /Did you mean: model\?/);
  });

  it("stays quiet when nothing is close", () => {
    assert.throws(() => parseCli(["zzzzzzzz"]), (error) => {
      assert.match(error.message, /Unknown command: zzzzzzzz/);
      assert.ok(!error.message.includes("Did you mean"));
      return true;
    });
  });
});

describe("parseCli contextual help guidance", () => {
  it("points harness-scoped command and option errors to harness help", () => {
    for (const argv of [
      ["claude", "statsu"],
      ["claude", "on", "unexpected"],
      ["claude", "model", "unknown"],
      ["claude", "on", "--serach", "glm"],
      ["claude", "on", "--model"],
    ]) {
      assert.throws(
        () => parseCli(argv),
        /Run: nexus claude help/,
      );
    }
  });

  it("points unresolved and global errors to global help", () => {
    for (const argv of [
      ["not-a-command"],
      ["login", "unexpected"],
      ["--not-a-flag"],
      ["--home"],
      ["model", "unknown"],
      ["demo", "--not-a-demo-flag"],
    ]) {
      assert.throws(
        () => parseCli(argv),
        /Run: nexus help/,
      );
    }
  });
});
