import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { globalConfigPath } from "../../lib/config/global-config.mjs";
import { piModelsPath } from "../../lib/harnesses/pi/core.mjs";
import { copilotProvidersPath } from "../../lib/harnesses/copilot-cli/config.mjs";
import { runFireconnect, withTempHome } from "../helpers.mjs";

const FW_KEY = "fw_test_key_12345";
const ANTHROPIC_KEY = "sk-ant-example-auto-0000";
const OPENAI_KEY = "sk-proj-example-auto-0000";

function env(home, extra = {}) {
  return {
    HOME: home,
    FIREWORKS_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    ...extra,
  };
}

async function ok(home, args, extra) {
  const result = await runFireconnect(args, env(home, extra));
  assert.equal(result.code, 0, result.stderr);
  return result;
}

describe("provider keys for Nexus Auto, saved with nexus auto", () => {
  it("saves both keys to config.json and reports where they apply", async () => {
    await withTempHome("auto-keys-save-", async (home) => {
      const result = await ok(home, ["auto", "--anthropic-api-key", ANTHROPIC_KEY, "--openai-api-key", OPENAI_KEY]);
      assert.match(result.stdout, /Saved the Anthropic key for Nexus Auto/);
      assert.match(result.stdout, /Nexus Auto sends it from Claude Desktop, OpenCode, Codex, Pi, VS Code, Copilot CLI, DeepSeek Harness/);
      assert.match(result.stdout, /Claude Code uses its own sign-in for these turns/);
      assert.match(result.stdout, /Nexus Auto sends it from Claude Code, Claude Desktop, OpenCode, Pi, VS Code, Copilot CLI, DeepSeek Harness/);
      assert.match(result.stdout, /Codex uses its own sign-in for these turns/);
      const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
      assert.equal(config.anthropicApiKey, ANTHROPIC_KEY);
      assert.equal(config.openaiApiKey, OPENAI_KEY);

      const status = await ok(home, ["auto", "--json"]);
      assert.deepEqual(JSON.parse(status.stdout).keys, { anthropic: true, openai: true });
    });
  });

  it("a bare provider-key flag without a TTY asks for a value instead of reading argv", async () => {
    await withTempHome("auto-keys-bare-flag-", async (home) => {
      const result = await runFireconnect(["auto", "--anthropic-api-key"], env(home));
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--anthropic-api-key requires a value/);
    });
  });

  it("shows account Provider Keys on the auto screen, next to local keys", async () => {
    await withTempHome("auto-keys-provider-keys-", async (home) => {
      const result = await ok(home, ["auto"], { FIREWORKS_API_KEY: "fw_providerkeys_test" });
      assert.match(result.stdout, /Local keys \(this machine\):/);
      assert.match(result.stdout, /Provider Keys \(your Fireworks account\):/);
      assert.match(result.stdout, /Anthropic: Connected \(sk-ant-••••2kAA\), covers every harness/);
      assert.match(result.stdout, /OpenAI: +Not connected/);
      assert.match(result.stdout, /Manage keys: https:\/\/app\.fireworks\.ai\/settings\/provider-keys/);

      const json = JSON.parse((await ok(home, ["auto", "--json"], { FIREWORKS_API_KEY: "fw_providerkeys_test" })).stdout);
      assert.equal(json.providerKeys.outcome, "ok");
      assert.equal(json.providerKeys.anthropic.state, "connected");
      assert.equal(json.providerKeys.openai.state, "not-connected");
    });
  });

  it("a connected Provider Key does not block saving a local key; the local key overrides it", async () => {
    await withTempHome("auto-keys-connected-override-", async (home) => {
      const saved = await ok(
        home,
        ["auto", "--anthropic-api-key", ANTHROPIC_KEY],
        { FIREWORKS_API_KEY: "fw_providerkeys_test" },
      );
      assert.match(saved.stdout, /Saved the Anthropic key for Nexus Auto/);
      const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
      assert.equal(config.anthropicApiKey, ANTHROPIC_KEY);

      const result = await ok(home, ["auto"], { FIREWORKS_API_KEY: "fw_providerkeys_test" });
      assert.match(result.stdout, /Anthropic key: +saved/);
      assert.match(result.stdout, /Anthropic: Connected \(sk-ant-••••2kAA\), covers every harness/);
      assert.match(result.stdout, /A saved local key overrides the Provider Key for that provider\./);
    });
  });

  it("shows Provider Keys as not enabled when the account has not enabled them", async () => {
    await withTempHome("auto-keys-provider-keys-off-", async (home) => {
      const result = await ok(home, ["auto"], { FIREWORKS_API_KEY: "fw_providerkeys-not-enabled_test" });
      assert.match(result.stdout, /Anthropic: Not enabled on this account/);
      assert.match(result.stdout, /OpenAI: +Not enabled on this account/);
    });
  });

  it("signed-out auto screen still renders, with a sign-in note for Provider Keys", async () => {
    await withTempHome("auto-keys-provider-keys-signed-out-", async (home) => {
      const result = await ok(home, ["auto"]);
      assert.match(result.stdout, /Anthropic: Sign in to see status/);
      assert.match(result.stdout, /OpenAI: +Sign in to see status/);
    });
  });

  it("pi: a saved key lands on the Fireworks provider headers and survives a plain re-on", async () => {
    await withTempHome("auto-keys-pi-", async (home) => {
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await ok(home, ["auto", "--anthropic-api-key", ANTHROPIC_KEY, "--openai-api-key", OPENAI_KEY]);
      await ok(home, ["pi", "on", "--api-key", FW_KEY]);
      const headers = () => readFile(piModelsPath(home), "utf8")
        .then((raw) => JSON.parse(raw).providers.fireworks.headers);
      assert.equal((await headers())["x-anthropic-api-key"], ANTHROPIC_KEY);
      assert.equal((await headers())["x-openai-api-key"], OPENAI_KEY);

      await ok(home, ["pi", "on", "--api-key", FW_KEY]);
      assert.equal((await headers())["x-anthropic-api-key"], ANTHROPIC_KEY);
    });
  });

  it("deepseek: a saved key lands on the dsh provider headers, and --unset removes it", async () => {
    await withTempHome("auto-keys-deepseek-", async (home) => {
      await mkdir(path.join(home, ".dsh"), { recursive: true });
      await ok(home, ["auto", "--anthropic-api-key", ANTHROPIC_KEY]);
      await ok(home, ["deepseek", "on", "--api-key", FW_KEY]);
      const settingsPath = path.join(home, ".dsh/settings.yaml");
      assert.match(await readFile(settingsPath, "utf8"), new RegExp(`x-anthropic-api-key: ${ANTHROPIC_KEY}`));

      const unset = await ok(home, ["auto", "--unset", "anthropic-api-key"]);
      assert.match(unset.stdout, /Removed the saved Anthropic key from DeepSeek Harness/);
      assert.doesNotMatch(await readFile(settingsPath, "utf8"), /x-anthropic-api-key/);
    });
  });

  it("copilot-cli: re-on keeps a provider key added by hand, and --unset removes it", async () => {
    await withTempHome("auto-keys-copilot-cli-", async (home) => {
      await ok(home, ["copilot-cli", "on", "--api-key", FW_KEY]);
      const providersPath = copilotProvidersPath({ home });
      const fireworks = async () => JSON.parse(await readFile(providersPath, "utf8"))
        .providers.find((entry) => entry.name === "fireworks");
      const written = JSON.parse(await readFile(providersPath, "utf8"));
      const provider = written.providers.find((entry) => entry.name === "fireworks");
      provider.headers = { ...(provider.headers ?? {}), "x-openai-api-key": OPENAI_KEY };
      await writeFile(providersPath, `${JSON.stringify(written, null, 2)}\n`);

      await ok(home, ["copilot-cli", "on", "--api-key", FW_KEY]);
      assert.equal((await fireworks()).headers["x-openai-api-key"], OPENAI_KEY);

      await ok(home, ["auto", "--unset", "openai-api-key"]);
      assert.equal((await fireworks()).headers?.["x-openai-api-key"], undefined);
    });
  });

  it("codex: the saved Anthropic key fills in for Claude turns, never the OpenAI key; --unset removes it", async () => {
    await withTempHome("auto-keys-codex-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await ok(home, ["auto", "--anthropic-api-key", ANTHROPIC_KEY, "--openai-api-key", OPENAI_KEY]);
      await ok(home, ["codex", "on", "--api-key", FW_KEY]);
      const configPath = path.join(home, ".codex/config.toml");
      const raw = await readFile(configPath, "utf8");
      assert.match(raw, new RegExp(`"x-anthropic-api-key" = "${ANTHROPIC_KEY}"`));
      assert.doesNotMatch(raw, /x-openai-api-key/);

      const unset = await ok(home, ["auto", "--unset", "anthropic-api-key"]);
      assert.match(unset.stdout, /Removed the saved Anthropic key from Codex/);
      const after = await readFile(configPath, "utf8");
      assert.doesNotMatch(after, /x-anthropic-api-key/);
      assert.match(after, /"x-fireworks-api-key" = "fw_test_key_12345"/);
    });
  });

  it("vscode: keys ride on the auto row only, not on pinned models", async () => {
    await withTempHome("auto-keys-vscode-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await writeFile(vscodePath, "[]\n");
      await ok(home, ["auto", "--anthropic-api-key", ANTHROPIC_KEY]);
      await ok(home, ["vscode", "on", "--api-key", FW_KEY, "--vscode-path", vscodePath, "--force"]);
      const provider = JSON.parse(await readFile(vscodePath, "utf8"))
        .find((entry) => entry.name === "Fireworks");
      const auto = provider.models.find((row) => row.id === "auto");
      assert.equal(auto.requestHeaders["x-anthropic-api-key"], ANTHROPIC_KEY);
      for (const row of provider.models.filter((entry) => entry.id !== "auto")) {
        assert.equal(row.requestHeaders?.["x-anthropic-api-key"], undefined, row.id);
      }
    });
  });

  it("exported keys, and environment references in config.json, never reach a harness", async () => {
    await withTempHome("auto-keys-env-", async (home) => {
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await mkdir(path.dirname(globalConfigPath(home)), { recursive: true });
      await writeFile(globalConfigPath(home), JSON.stringify({ anthropicApiKey: "{env:ANTHROPIC_API_KEY}" }));
      await ok(
        home,
        ["pi", "on", "--api-key", FW_KEY],
        { ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY },
      );
      const raw = await readFile(piModelsPath(home), "utf8").catch(() => "");
      assert.doesNotMatch(raw, /sk-ant-example-auto|sk-proj-example-auto/);
    });
  });

  it("rejects --unset together with the same key", async () => {
    await withTempHome("auto-keys-conflict-", async (home) => {
      const result = await runFireconnect(
        ["auto", "--openai-api-key", OPENAI_KEY, "--unset", "openai-api-key"],
        env(home),
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--openai-api-key and --unset openai-api-key cannot be used together/);
    });
  });

  it("while auto is limited to Fireworks, saved keys stay saved but no harness gets them", async () => {
    await withTempHome("auto-keys-fireworks-scope-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await ok(home, ["auto", "--providers", "fireworks"]);
      const saved = await ok(home, ["auto", "--anthropic-api-key", ANTHROPIC_KEY, "--openai-api-key", OPENAI_KEY]);
      assert.match(saved.stdout, /Auto is limited to fireworks, so Nexus doesn't send it/);
      assert.doesNotMatch(saved.stdout, /Nexus Auto sends it from/);
      const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
      assert.equal(config.openaiApiKey, OPENAI_KEY);

      await ok(home, ["pi", "on", "--api-key", FW_KEY]);
      await ok(home, ["codex", "on", "--api-key", FW_KEY]);
      const piHeaders = () => readFile(piModelsPath(home), "utf8")
        .then((raw) => JSON.parse(raw).providers.fireworks.headers);
      const codexToml = () => readFile(path.join(home, ".codex/config.toml"), "utf8");
      assert.equal((await piHeaders())["x-nexus-providers"], "fireworks");
      assert.equal((await piHeaders())["x-openai-api-key"], undefined);
      assert.equal((await piHeaders())["x-anthropic-api-key"], undefined);
      assert.doesNotMatch(await codexToml(), /x-anthropic-api-key/);

      const status = await ok(home, ["auto"]);
      assert.match(status.stdout, /OpenAI key: +saved, not sent while auto is limited to fireworks/);
      const json = JSON.parse((await ok(home, ["auto", "--json"])).stdout);
      assert.deepEqual(json.keys, { anthropic: true, openai: true });
      assert.deepEqual(json.keysSent, { anthropic: false, openai: false });

      const reset = await ok(home, ["auto", "--reset"]);
      assert.match(reset.stdout, /Your saved Anthropic and OpenAI keys are sent again once you re-run your harness/);
      await ok(home, ["pi", "on", "--api-key", FW_KEY]);
      await ok(home, ["codex", "on", "--api-key", FW_KEY]);
      assert.equal((await piHeaders())["x-openai-api-key"], OPENAI_KEY);
      assert.match(await codexToml(), new RegExp(`"x-anthropic-api-key" = "${ANTHROPIC_KEY}"`));

      const scoped = await ok(home, ["auto", "--providers", "fireworks"]);
      assert.match(scoped.stdout, /Your saved Anthropic and OpenAI keys stay saved but aren't sent while auto is limited to fireworks/);
      await ok(home, ["pi", "on", "--api-key", FW_KEY]);
      await ok(home, ["codex", "on", "--api-key", FW_KEY]);
      assert.equal((await piHeaders())["x-openai-api-key"], undefined);
      assert.doesNotMatch(await codexToml(), /x-anthropic-api-key/);
    });
  });

  it("an invalid --providers value fails before the key is saved", async () => {
    await withTempHome("auto-keys-bad-providers-", async (home) => {
      const result = await runFireconnect(
        ["auto", "--openai-api-key", OPENAI_KEY, "--providers", "openai,"],
        env(home),
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--providers must be a comma-separated list/);
      const raw = await readFile(globalConfigPath(home), "utf8").catch(() => "{}");
      assert.equal(JSON.parse(raw).openaiApiKey ?? "", "");
    });
  });

  it("configure: a failed Azure check fails before the key is saved", async () => {
    await withTempHome("auto-keys-configure-azure-", async (home) => {
      const result = await runFireconnect(
        ["configure", "--anthropic-api-key", ANTHROPIC_KEY, "--provider", "azure"],
        env(home),
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Azure endpoint found/);
      const raw = await readFile(globalConfigPath(home), "utf8").catch(() => "{}");
      assert.equal(JSON.parse(raw).anthropicApiKey ?? "", "");
    });
  });

  it("--json on a key change prints only the JSON status", async () => {
    await withTempHome("auto-keys-json-", async (home) => {
      const saved = await ok(home, ["auto", "--json", "--openai-api-key", OPENAI_KEY]);
      assert.deepEqual(JSON.parse(saved.stdout).keys, { anthropic: false, openai: true });

      const unset = await ok(home, ["auto", "--json", "--unset", "openai-api-key"]);
      assert.deepEqual(JSON.parse(unset.stdout).keys, { anthropic: false, openai: false });
      assert.match(unset.stderr, /Removed the saved OpenAI key/);

      const both = await ok(home, ["auto", "--json", "--anthropic-api-key", ANTHROPIC_KEY, "--providers", "fireworks"]);
      const status = JSON.parse(both.stdout);
      assert.deepEqual(status.keys, { anthropic: true, openai: false });
      assert.deepEqual(status.providers, ["fireworks"]);
    });
  });
});
