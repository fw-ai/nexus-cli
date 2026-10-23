import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../../lib/cli/parse-args.mjs";
import { globalConfigPath } from "../../lib/config/global-config.mjs";
import { runFireconnect } from "../helpers.mjs";

describe("configure (provider / FireRouter setup)", () => {
  it("stores a literal Anthropic API key in global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-anthropic-"));
    const result = await runFireconnect(
      ["configure", "--anthropic-api-key", "sk-ant-configure-12345"],
      { HOME: home, ANTHROPIC_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Saved the Anthropic key/);
    assert.match(result.stderr + result.stdout, /`nexus configure --anthropic-api-key` is deprecated\. Use `nexus auto`/);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.anthropicApiKey, "sk-ant-configure-12345");
  });

  it("stores a literal OpenAI API key in global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-openai-"));
    const result = await runFireconnect(
      ["configure", "--openai-api-key", "sk-proj-configure-12345"],
      { HOME: home, OPENAI_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Saved the OpenAI key/);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.openaiApiKey, "sk-proj-configure-12345");
  });

  it("rejects a mislabeled Anthropic key as the OpenAI key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-openai-mislabeled-"));
    const result = await runFireconnect(
      ["configure", "--openai-api-key", "sk-ant-not-openai"],
      { HOME: home, OPENAI_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /must be an OpenAI API key/);
  });

  it("rejects --api-key unless --provider azure (Fireworks key belongs to login)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-apikey-guard-"));
    const result = await runFireconnect(
      ["configure", "--api-key", "fw_should_not_store_here"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /nexus login/);
    assert.match(result.stderr, /requires --provider azure/);
  });

  it("prints guidance and exits 0 when nothing is configured", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-noop-"));
    const result = await runFireconnect(["configure"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Nothing to configure/);
    assert.match(result.stdout, /nexus login/);
  });

  it("rejects removed --api-key-mode flag", () => {
    assert.throws(
      () => parseCli(["configure", "--api-key-mode", "literal"]),
      /Unknown argument: --api-key-mode/,
    );
  });

  it("refuses to set and unset the same provider key in one run", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-set-unset-"));
    const result = await runFireconnect(
      ["configure", "--openai-api-key", "sk-proj-configure-12345", "--unset", "openai-api-key"],
      { HOME: home, OPENAI_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--openai-api-key and --unset openai-api-key cannot be used together/);
  });

  it("unsets one provider key and keeps the other", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-unset-one-"));
    const env = { HOME: home, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" };
    await runFireconnect(["configure", "--openai-api-key", "sk-proj-configure-12345"], env);
    await runFireconnect(["configure", "--anthropic-api-key", "sk-ant-configure-12345"], env);

    const result = await runFireconnect(["configure", "--unset", "openai-api-key"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Removed the saved OpenAI key\./);
    assert.doesNotMatch(result.stdout, /Saved to/);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.openaiApiKey ?? "", "");
    assert.equal(config.anthropicApiKey, "sk-ant-configure-12345");
  });

  it("says an exported key isn't sent by Nexus CLI after --unset", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-unset-env-"));
    const result = await runFireconnect(
      ["configure", "--unset", "openai-api-key"],
      { HOME: home, OPENAI_API_KEY: "sk-proj-env-only-12345", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /OPENAI_API_KEY is still set in your environment\. Nexus CLI doesn't send it/);
    assert.doesNotMatch(result.stdout, /keep sending/);
  });

  it("rejects an unknown --unset key", () => {
    assert.throws(
      () => parseCli(["configure", "--unset", "fireworks-api-key"]),
      /--unset takes anthropic-api-key or openai-api-key, not fireworks-api-key/,
    );
  });

  it("rejects --unset on a harness command", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-harness-unset-flag-"));
    const result = await runFireconnect(["opencode", "on", "--unset", "openai-api-key"], { HOME: home });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /nexus auto --unset openai-api-key/);
  });
});
