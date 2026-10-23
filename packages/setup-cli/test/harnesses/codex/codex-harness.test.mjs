import { mkdtemp, readFile, writeFile, mkdir, unlink, access, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  codexBackupPath,
  codexCatalogPath,
  codexConfigPath,
  codexDataDir,
  refreshCodexGatewayKey,
} from "../../../lib/harnesses/codex/core.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { writeJson } from "../../../lib/io/json.mjs";
import { clearListPriceCache, setListPriceCacheRates } from "../../../lib/pricing/list-price-cache.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import {
  FIRECONNECT_REFERER,
  FW_CODEX_KEY,
  SK_ANT_KEY,
  mockServerlessModel,
  runFireconnect,
  seedKeychainConfig,
  seedServerlessCatalogCache,
  withoutEnvFireworksKey,
  writeCodexConfig,
} from "../../helpers.mjs";

describe("codex harness integration", () => {
  it("rejects Claude Code context suffixes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-context-suffix-"));
    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "kimi-k3[1m]"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /\[1m\] model suffixes are only supported by Claude Code/);
  });

  it("re-on preserves the model selected under the managed Fireworks provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-provider-model-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      'model_provider = "fireworks-ai"',
      'model = "o4-mini"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "Fireworks"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'experimental_bearer_token = "fw_test_key_12345"',
      "",
    ].join("\n"));

    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parseToml(await readFile(configPath, "utf8")).root.model, "o4-mini");
  });

  it("re-on preserves a cataloged Fireworks gpt-oss model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-gpt-oss-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    seedServerlessCatalogCache(home, [
      mockServerlessModel({
        name: "accounts/fireworks/models/gpt-oss-120b",
        displayName: "GPT OSS 120B",
      }),
    ]);

    for (const args of [
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "gpt-oss-120b"],
      ["codex", "on", "--api-key", "fw_test_key_12345"],
    ]) {
      const result = await runFireconnect(args, { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(
      parseToml(await readFile(codexConfigPath(home), "utf8")).root.model,
      "gpt-oss-120b",
    );
  });

  it("first plain on seeds over an unreferenced catalog file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-first-catalog-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(codexCatalogPath(home), '{"models":[]}\n');

    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_cataloged_v1_adversarial000000"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    assert.ok(catalog.models.some((model) => model.slug === "kimi-latest"));
  });

  it("off restores an unreferenced catalog file byte-for-byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-user-catalog-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const original = '{"models":[{"slug":"user-model"}]}\n';
    await writeFile(codexCatalogPath(home), original);

    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_cataloged_v1_adversarial000000"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    const off = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(codexCatalogPath(home), "utf8"), original);
  });

  it("adds an explicit model from a stale catalog cache", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-stale-cache-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    seedServerlessCatalogCache(home, [
      mockServerlessModel({
        name: "accounts/fireworks/models/cached-model",
        displayName: "Cached Model",
      }),
    ]);

    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "cached-model"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    assert.ok(catalog.models.some((model) => model.slug === "cached-model"));
  });

  it("rejects the full firerouter router id as a model selection", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-firerouter-manual-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const result = await runFireconnect(
      [
        "codex",
        "on",
        "--api-key",
        "fw_test_key_12345",
        "--model",
        "accounts/fireworks/routers/firerouter",
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /is no longer supported/);
    assert.equal(existsSync(codexConfigPath(home)), false);
  });

  it("a first plain on selects auto without Anthropic credentials", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-plain-on-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    const config = await readFile(codexConfigPath(home), "utf8");
    assert.match(config, /model_provider = "fireworks-ai"/);
    assert.match(config, /^model = "auto"$/m);
    assert.doesNotMatch(config, /x-anthropic-api-key/);
    assert.doesNotMatch(result.stderr, /ANTHROPIC_API_KEY or workspace BYOK/);
  });

  it("re-on without --model drops a FireRouter path to auto and keeps model_catalog_json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-firerouter-path-reron-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const apiKey = "fw_cataloged_v1_adversarial000000";
    const first = await runFireconnect(
      ["codex", "on", "--api-key", apiKey],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);
    // What an earlier release wrote for `--model firerouter/test-model`.
    const seededConfig = (await readFile(codexConfigPath(home), "utf8"))
      .replace(/^model = .*$/m, 'model = "firerouter/test-model"');
    await writeFile(codexConfigPath(home), seededConfig);
    const seededCatalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    seededCatalog.models.push({ slug: "firerouter/test-model", display_name: "FireRouter · Test" });
    await writeFile(codexCatalogPath(home), JSON.stringify(seededCatalog));
    const afterSelect = await readFile(codexConfigPath(home), "utf8");
    assert.match(afterSelect, /model = "firerouter\/test-model"/);
    assert.match(afterSelect, /model_catalog_json/);

    const rerun = await runFireconnect(
      ["codex", "on", "--api-key", apiKey],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(rerun.code, 0, rerun.stderr);
    const afterRerun = await readFile(codexConfigPath(home), "utf8");
    assert.match(afterRerun, /^model = "auto"$/m);
    assert.match(afterRerun, /model_catalog_json/);
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
    assert.ok(slugs.includes("auto"));
    assert.ok(!slugs.includes("firerouter/test-model"));
  });

  it("fresh on with --model seeds the full catalog, not just the selected model", async () => {
    // The ChatGPT app dropdown lists whatever the catalog file holds. A fresh
    // `--model` run used to write only the selected row, leaving a one-entry
    // menu; seed the whole fetched catalog so every Fireworks model is pickable.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-fresh-model-full-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    seedServerlessCatalogCache(home, [
      mockServerlessModel({
        name: "accounts/fireworks/models/alpha-one",
        displayName: "Alpha One",
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/beta-two",
        displayName: "Beta Two",
      }),
    ]);
    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "beta-two"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(codexConfigPath(home), "utf8"), /model = "beta-two"/);
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8"))
      .models.map((row) => row.slug);
    assert.ok(slugs.includes("beta-two"));
    assert.ok(slugs.includes("alpha-one"), `expected full catalog, got ${slugs.join(",")}`);
  });

  it("second on with no changes is a file-level no-op", async () => {
    // The thin mock catalog also exercises context repair.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-rerun-noop-"));
    const args = ["codex", "on", "--api-key", "fw_cataloged_rerun_key_0000000000", "--model", "kimi-latest"];
    const first = await runFireconnect(args, { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(first.code, 0, first.stderr);
    const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    const kimi = catalog.models.find((entry) => entry.slug === "kimi-latest");
    assert.ok(kimi);
    assert.ok(kimi.context_window > 0, `expected usable context, got ${kimi.context_window}`);
    const configBefore = await readFile(codexConfigPath(home), "utf8");
    const catalogBefore = await readFile(codexCatalogPath(home), "utf8");
    const configMtime = (await stat(codexConfigPath(home))).mtimeMs;
    const catalogMtime = (await stat(codexCatalogPath(home))).mtimeMs;
    const second = await runFireconnect(args, { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(await readFile(codexConfigPath(home), "utf8"), configBefore);
    assert.equal(await readFile(codexCatalogPath(home), "utf8"), catalogBefore);
    assert.equal((await stat(codexConfigPath(home))).mtimeMs, configMtime);
    assert.equal((await stat(codexCatalogPath(home))).mtimeMs, catalogMtime);
  });

  it("rejects MiniMax models with an explanatory error", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-minimax-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "minimax-m3"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MiniMax is not supported with Codex/);
    assert.match(result.stderr, /Responses API/);
    assert.match(result.stderr, /tool_calls/);
  });

  it("rejects re-on when config already has a MiniMax model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-minimax-reon-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      'model_provider = "fireworks-ai"',
      'model = "minimax-m3"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "Fireworks"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'wire_api = "responses"',
      'experimental_bearer_token = "fw_test_key_12345"',
      "requires_openai_auth = false",
      "",
    ].join("\n"));

    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MiniMax is not supported with Codex/);
    assert.match(result.stderr, /Responses API/);
  });

  it("a plain on signs Codex in and keeps the key in a header", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-chatgpt-login-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = 'model = "example-model"\n';
    await writeFile(configPath, original);

    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /sign in with ChatGPT and GPT turns use your plan/);
    assert.doesNotMatch(on.stdout, /fireconnect key export \| codex login --with-api-key/);
    const table = parseToml(await readFile(configPath, "utf8")).tables["model_providers.fireworks-ai"];
    assert.equal(table.requires_openai_auth, true);
    assert.equal(table.experimental_bearer_token, undefined);
    assert.equal(table.http_headers["x-fireworks-api-key"], "fw_test_key_12345");
    assert.equal((await readGlobalConfig(home)).harnesses.codex?.chatgptLogin, undefined);

    // Upgrades and migrations re-run a plain `on`; the mode must survive it.
    const reOn = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(reOn.code, 0, reOn.stderr);
    const reTable = parseToml(await readFile(configPath, "utf8")).tables["model_providers.fireworks-ai"];
    assert.equal(reTable.requires_openai_auth, true);
    assert.equal(reTable.experimental_bearer_token, undefined);

    const off = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("key rotation keeps Codex's sign-in mode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-chatgpt-rotate-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    assert.equal(
      await refreshCodexGatewayKey({ configPath, fireworksKey: "fw_rotated_key_67890" }),
      true,
    );
    const table = parseToml(await readFile(configPath, "utf8")).tables["model_providers.fireworks-ai"];
    assert.equal(table.requires_openai_auth, true);
    assert.equal(table.experimental_bearer_token, undefined);
    assert.equal(table.http_headers["x-fireworks-api-key"], "fw_rotated_key_67890");
    assert.equal(
      await refreshCodexGatewayKey({ configPath, fireworksKey: "fw_rotated_key_67890" }),
      false,
    );
  });

  it("there is no flag to turn Codex's sign-in on or off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-chatgpt-login-flag-"));
    for (const flag of ["--chatgpt-login", "--no-chatgpt-login"]) {
      const result = await runFireconnect(
        ["codex", "on", "--api-key", "fw_test_key_12345", flag],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.notEqual(result.code, 0, flag);
      assert.match(result.stderr, new RegExp(`Unknown argument: ${flag}`), flag);
    }
  });

  it("an open model keeps Codex's sign-in, the Fireworks key header, and the GPT rows", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-chatgpt-switch-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    seedServerlessCatalogCache(home, [
      mockServerlessModel({ name: "accounts/fireworks/models/example-model", displayName: "Example" }),
    ]);
    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const switched = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "example-model"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(switched.code, 0, switched.stderr);
    assert.match(switched.stdout, /Codex keeps its own sign-in/);
    const doc = parseToml(await readFile(configPath, "utf8"));
    assert.equal(doc.root.model, "example-model");
    const table = doc.tables["model_providers.fireworks-ai"];
    assert.equal(table.requires_openai_auth, true);
    assert.equal(table.experimental_bearer_token, undefined);
    assert.equal(table.http_headers?.["x-fireworks-api-key"], "fw_test_key_12345");
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
    assert.ok(!slugs.includes("firerouter"), slugs.join(", "));
    assert.ok(slugs.includes("gpt-6-astra"), slugs.join(", "));
    assert.ok(slugs.includes("example-model"), slugs.join(", "));
  });

  it("re-on after picking a GPT row in /model keeps Codex's sign-in on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-chatgpt-gpt-pick-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const picked = (await readFile(configPath, "utf8")).replace(/^model = .*$/m, 'model = "gpt-6-astra"');
    await writeFile(configPath, picked);
    const reOn = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(reOn.code, 0, reOn.stderr);
    assert.doesNotMatch(reOn.stdout, /sign-in is off/);
    const doc = parseToml(await readFile(configPath, "utf8"));
    assert.equal(doc.root.model, "gpt-6-astra");
    const table = doc.tables["model_providers.fireworks-ai"];
    assert.equal(table.requires_openai_auth, true);
    assert.equal(table.experimental_bearer_token, undefined);
    assert.equal(table.http_headers["x-fireworks-api-key"], "fw_test_key_12345");
    const catalog = JSON.parse(await readFile(path.join(path.dirname(configPath), "fireworks-model-catalog.json"), "utf8"));
    assert.ok(!catalog.models.some((row) => row.slug === "firerouter"));
  });

  it("on --model with a GPT picker id skips the serverless catalog and turns Codex's sign-in on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-chatgpt-gpt-flag-"));
    const configPath = codexConfigPath(home);
    seedServerlessCatalogCache(home, [
      mockServerlessModel({ name: "accounts/fireworks/models/example-model", displayName: "Example" }),
    ]);
    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "gpt-6-astra"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /gpt-6-astra then needs an OpenAI Provider Key/);
    assert.match(on.stdout, /docs\.fireworks\.ai\/nexus\/provider-keys/);
    assert.match(on.stdout, /use `auto`, which falls back to open models/);
    assert.doesNotMatch(on.stdout, /codex login --with-api-key/);
    assert.doesNotMatch(on.stdout, /firerouter/);
    const doc = parseToml(await readFile(configPath, "utf8"));
    assert.equal(doc.root.model, "gpt-6-astra");
    const table = doc.tables["model_providers.fireworks-ai"];
    assert.equal(table.requires_openai_auth, true);
    assert.equal(table.experimental_bearer_token, undefined);
    assert.equal(table.http_headers["x-fireworks-api-key"], "fw_test_key_12345");
    const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    assert.ok(catalog.models.some((row) => row.slug === "gpt-6-astra"));

    const unknown = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "gpt-example-model"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /not available on Fireworks/);
  });

  it("Codex forwards only the saved Anthropic key: never an OpenAI key, never an exported key", async () => {
    const env = {
      FIREWORKS_API_KEY: "",
      ANTHROPIC_API_KEY: "sk-ant-shell-0000",
      OPENAI_API_KEY: "sk-shell-0000",
      SHELL: "/bin/bash",
      ZSH_VERSION: "",
      BASH_VERSION: "5",
    };
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-no-provider-keys-"));
    await seedKeychainConfig(home, "fw_test_key_12345");
    await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-example-0000", openaiApiKey: "sk-example-0000" });

    for (const args of [
      ["codex", "on", "--model", "gpt-6-astra"],
      ["codex", "on", "--model", "example-model"],
      ["codex", "on"],
    ]) {
      const result = await runFireconnect(args, { HOME: home, ...env });
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
      const raw = await readFile(codexConfigPath(home), "utf8");
      // Codex's own sign-in covers GPT turns; the saved Anthropic key fills in
      // for Claude turns. Nothing from the shell environment.
      assert.doesNotMatch(raw, /x-openai-api-key|OPENAI_API_KEY|sk-example-0000|sk-shell|sk-ant-shell/, args.join(" "));
      const table = parseToml(raw).tables["model_providers.fireworks-ai"];
      assert.equal(table.requires_openai_auth, true, args.join(" "));
      assert.equal(table.http_headers["x-fireworks-api-key"], "fw_test_key_12345", args.join(" "));
      assert.equal(table.http_headers["x-anthropic-api-key"], "sk-ant-example-0000", args.join(" "));
      assert.doesNotMatch(result.stdout, /OPENAI_API_KEY|removed the provider-key headers/, args.join(" "));
    }
    const shellConfig = process.platform === "darwin" ? ".bash_profile" : ".bashrc";
    const shell = await readFile(path.join(home, shellConfig), "utf8").catch(() => "");
    assert.doesNotMatch(shell, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);

    const off = await runFireconnect(["codex", "off", "--openai-api-key", "sk-example-4444"], { HOME: home, ...env });
    assert.notEqual(off.code, 0);
    assert.match(off.stderr, /Codex's own sign-in covers GPT turns/);
  });

  it("on --model with an older GPT picker id lists it after models.dev moves on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-chatgpt-gpt-older-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      setListPriceCacheRates({
        openai: { "gpt-99-astra": { family: "gpt-astra", label: "GPT-99 Astra", contextWindow: 1_000_000 } },
      }, { persist: true });
    } finally {
      clearListPriceCache();
      process.env.HOME = prevHome;
    }
    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "gpt-6-astra"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    const doc = parseToml(await readFile(codexConfigPath(home), "utf8"));
    assert.equal(doc.root.model, "gpt-6-astra");
    assert.ok(doc.root.model_catalog_json, "model_catalog_json is set");
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
    assert.ok(slugs.includes("gpt-99-astra"), slugs.join(", "));
    assert.ok(slugs.includes("gpt-6-astra"), slugs.join(", "));
  });

  it("a re-on removes the provider-key headers an earlier release wrote, and says so once", async () => {
    const env = { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" };
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-drop-provider-keys-"));
    await seedKeychainConfig(home, "fw_test_key_12345");
    const on = await runFireconnect(["codex", "on"], { HOME: home, ...env });
    assert.equal(on.code, 0, on.stderr);
    const legacy = (await readFile(codexConfigPath(home), "utf8")).replace(
      /^(http_headers = \{.*) \}$/m,
      '$1, "x-openai-api-key" = "sk-example-0000" }\n'
        + 'env_http_headers = { "x-openai-api-key" = "OPENAI_API_KEY", "x-anthropic-api-key" = "ANTHROPIC_API_KEY" }',
    );
    assert.match(legacy, /sk-example-0000/);
    await writeFile(codexConfigPath(home), legacy);

    const reOn = await runFireconnect(["codex", "on"], { HOME: home, ...env });
    assert.equal(reOn.code, 0, reOn.stderr);
    assert.match(reOn.stdout, /removed the provider-key headers from config\.toml/);
    assert.match(reOn.stdout, /codex login --with-api-key/);
    const raw = await readFile(codexConfigPath(home), "utf8");
    assert.doesNotMatch(raw, /x-openai-api-key|x-anthropic-api-key|sk-example-0000|env_http_headers/);
    assert.match(raw, /"x-fireworks-api-key" = "fw_test_key_12345"/);

    const again = await runFireconnect(["codex", "on"], { HOME: home, ...env });
    assert.equal(again.code, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /removed the provider-key headers/);
  });

  it("a re-on keeps an Anthropic key added by hand, drops an OpenAI one, and drops both while auto is Fireworks-only", async () => {
    const env = { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" };
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-hand-added-key-"));
    await seedKeychainConfig(home, "fw_test_key_12345");
    const on = await runFireconnect(["codex", "on"], { HOME: home, ...env });
    assert.equal(on.code, 0, on.stderr);
    const handEdited = (await readFile(codexConfigPath(home), "utf8")).replace(
      /^(http_headers = \{.*) \}$/m,
      '$1, "x-anthropic-api-key" = "sk-ant-example-hand-0000", "x-openai-api-key" = "sk-example-hand-0000" }',
    );
    assert.match(handEdited, /sk-ant-example-hand-0000/);
    await writeFile(codexConfigPath(home), handEdited);
    const headers = async () => parseToml(await readFile(codexConfigPath(home), "utf8"))
      .tables["model_providers.fireworks-ai"].http_headers;

    const reOn = await runFireconnect(["codex", "on"], { HOME: home, ...env });
    assert.equal(reOn.code, 0, reOn.stderr);
    assert.equal((await headers())["x-anthropic-api-key"], "sk-ant-example-hand-0000");
    assert.equal((await headers())["x-openai-api-key"], undefined);

    await writeGlobalConfig(home, { auto: { providers: ["fireworks"] } });
    const scoped = await runFireconnect(["codex", "on"], { HOME: home, ...env });
    assert.equal(scoped.code, 0, scoped.stderr);
    assert.equal((await headers())["x-anthropic-api-key"], undefined);
    assert.equal((await headers())["x-fireworks-api-key"], "fw_test_key_12345");
  });

  it("configure --unset openai-api-key leaves Codex's config alone and never waits for Codex sessions", async () => {
    const env = { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" };
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-unset-provider-keys-"));
    await seedKeychainConfig(home, "fw_test_key_12345");
    await writeGlobalConfig(home, { openaiApiKey: "sk-example-0000" });
    const on = await runFireconnect(["codex", "on"], { HOME: home, ...env });
    assert.equal(on.code, 0, on.stderr);
    const before = await readFile(codexConfigPath(home), "utf8");

    const session = { NEXUS_TEST_CODEX_PS: "  301 /usr/local/bin/codex" };
    const unset = await runFireconnect(["configure", "--unset", "openai-api-key"], { HOME: home, ...env, ...session });
    assert.equal(unset.code, 0, unset.stderr);
    assert.match(unset.stdout, /Removed the saved OpenAI key/);
    assert.doesNotMatch(unset.stdout, /from Codex|Codex is running/);
    assert.equal(await readFile(codexConfigPath(home), "utf8"), before);
    assert.equal((await readGlobalConfig(home)).openaiApiKey, "");
  });

  it("status reports Codex's sign-in mode and where the Fireworks key lives", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-chatgpt-status-"));
    await mkdir(path.dirname(codexConfigPath(home)), { recursive: true });
    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const text = await runFireconnect(["codex", "status"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Auth: Codex sign-in; Fireworks key in x-fireworks-api-key header in config\.toml/);
    assert.match(text.stdout, /^Model: auto$/m);
    assert.doesNotMatch(text.stdout, /experimental_bearer_token/);

    const json = await runFireconnect(["codex", "status", "--json"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(json.code, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.chatgptLogin, true);
    assert.equal(payload.fireworksKeyHeader, "x-fireworks-api-key");
    assert.equal(payload.current.main, "auto");
    assert.equal(payload.defaults.main, "auto");

    await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "auto"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    const plain = JSON.parse(
      (await runFireconnect(["codex", "status", "--json"], { HOME: home, FIREWORKS_API_KEY: "" })).stdout,
    );
    assert.equal(plain.chatgptLogin, true);
    assert.equal(plain.fireworksKeyHeader, "x-fireworks-api-key");
    assert.equal(plain.current.main, "auto");
  });

  it("a first plain on uses auto with Codex's sign-in; a re-on keeps the current model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-chatgpt-auto-default-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    const providerTable = async () => parseToml(await readFile(configPath, "utf8"))
      .tables["model_providers.fireworks-ai"];

    const on = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(on.code, 0, on.stderr);
    assert.match(await readFile(configPath, "utf8"), /^model = "auto"$/m);
    assert.match(on.stdout, /Codex → Fireworks · auto\n/);
    assert.match(on.stdout, /GPT turns use your plan/);
    assert.equal((await providerTable()).requires_openai_auth, true);

    const auto = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345", "--model", "auto"], env);
    assert.equal(auto.code, 0, auto.stderr);
    assert.match(auto.stdout, /Codex keeps its own sign-in/);
    assert.equal((await providerTable()).experimental_bearer_token, undefined);
    assert.equal((await providerTable()).requires_openai_auth, true);

    const reOn = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(reOn.code, 0, reOn.stderr);
    assert.match(await readFile(configPath, "utf8"), /^model = "auto"$/m);
    assert.equal((await providerTable()).requires_openai_auth, true);

    // After `off`, the next `on` is a first one again.
    assert.equal((await runFireconnect(["codex", "off"], env)).code, 0);
    const again = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(await readFile(configPath, "utf8"), /^model = "auto"$/m);
    assert.equal((await providerTable()).requires_openai_auth, true);
  });

  it("lists stock Codex's own GPT models and accepts them as --model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-stock-models-"));
    await seedKeychainConfig(home, "fw_test_key_12345");
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "",
      OPENAI_API_KEY: "",
      NEXUS_TEST_CODEX_MODELS: JSON.stringify({
        models: [
          { slug: "gpt-9-sol", display_name: "GPT-9-Sol", visibility: "list", priority: 1, context_window: 200000 },
          { slug: "gpt-9-astra", display_name: "GPT-9-Astra", visibility: "list", priority: 2, context_window: 200000 },
          { slug: "gpt-9-internal", display_name: "Internal", visibility: "hide", priority: 3 },
        ],
      }),
    };
    const on = await runFireconnect(["codex", "on"], env);
    assert.equal(on.code, 0, on.stderr);
    const rows = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models;
    assert.deepEqual(rows.slice(0, 2).map((row) => row.slug), ["gpt-9-sol", "gpt-9-astra"]);
    assert.equal(rows[0].display_name, "GPT-9-Sol");
    assert.ok(!rows.some((row) => row.slug === "gpt-9-internal"));

    const pick = await runFireconnect(["codex", "on", "--model", "gpt-9-astra"], env);
    assert.equal(pick.code, 0, pick.stderr);
    assert.equal(parseToml(await readFile(codexConfigPath(home), "utf8")).root.model, "gpt-9-astra");
  });

  it("reads stock Codex's list before checking --model, so a first run accepts a stock-only GPT model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-stock-first-model-"));
    seedServerlessCatalogCache(home, [
      mockServerlessModel({ name: "accounts/fireworks/models/example-model", displayName: "Example" }),
    ]);
    const on = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345", "--model", "gpt-9.4"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
      OPENAI_API_KEY: "",
      NEXUS_TEST_CODEX_MODELS: JSON.stringify({
        models: [{ slug: "gpt-9.4", display_name: "GPT-9.4", visibility: "list", priority: 1, context_window: 200000 }],
      }),
    });
    assert.equal(on.code, 0, on.stderr);
    assert.equal(parseToml(await readFile(codexConfigPath(home), "utf8")).root.model, "gpt-9.4");
    const rows = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models;
    assert.ok(rows.some((row) => row.slug === "gpt-9.4"));
  });

  it("Codex's sign-in lists the OpenAI models at the top of the picker, with no FireRouter row", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-signin-rows-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    const signInSlugs = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"];
    const catalogSlugs = async () => JSON.parse(await readFile(codexCatalogPath(home), "utf8"))
      .models.map((row) => row.slug);
    seedServerlessCatalogCache(home, [
      mockServerlessModel({ name: "accounts/fireworks/models/example-model", displayName: "Example" }),
    ]);

    const on = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(on.code, 0, on.stderr);
    assert.doesNotMatch(on.stdout, /FireRouter is on/);
    const slugs = await catalogSlugs();
    assert.deepEqual(slugs.slice(0, signInSlugs.length), signInSlugs);
    assert.ok(slugs.slice(signInSlugs.length).includes("example-model"), slugs.join(","));
    const rows = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models;
    const astra = rows.find((row) => row.slug === "gpt-6-astra");
    assert.equal(astra.display_name, "GPT-6 Astra");
    assert.equal(astra.context_window, 1_050_000);
    assert.deepEqual(astra.input_modalities, ["text", "image"]);
    assert.deepEqual(slugs.filter((slug) => slug.startsWith("firerouter")), []);

    // A re-on refreshes the catalog without dropping or duplicating the block.
    const reOn = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(reOn.code, 0, reOn.stderr);
    assert.deepEqual(await catalogSlugs(), slugs);

    // FireRouter selections are rejected and leave the catalog alone.
    for (const model of ["firerouter", "firerouter/astra"]) {
      const rejected = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345", "--model", model], env);
      assert.notEqual(rejected.code, 0, model);
      assert.match(rejected.stderr, /is no longer supported/, model);
    }
    assert.match(await readFile(codexConfigPath(home), "utf8"), /^model = "auto"$/m);
    assert.deepEqual(await catalogSlugs(), slugs);
  });

  it("a re-on drops a saved firerouter/astra to auto, whichever release saved it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-explicit-astra-reon-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    const on = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(on.code, 0, on.stderr);
    // What an earlier release saved for `--model firerouter/astra`.
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(/^model = "auto"$/m, 'model = "firerouter/astra"'),
    );
    const seededCatalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    seededCatalog.models.push({ slug: "firerouter/astra", display_name: "FireRouter · Astra" });
    await writeFile(codexCatalogPath(home), JSON.stringify(seededCatalog));
    // The release that wrote the config doesn't matter; the Astra row's own label does.
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8"))
        .replace(/"HTTP-Referer" = "fireconnect\/[^"]*"/, '"HTTP-Referer" = "fireconnect/v0.9.9"'),
    );

    const reOn = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(reOn.code, 0, reOn.stderr);
    assert.match(await readFile(configPath, "utf8"), /^model = "auto"$/m);
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
    assert.deepEqual(slugs.filter((slug) => slug.startsWith("firerouter")), []);
  });

  it("a re-on moves an earlier release's saved firerouter/astra to auto", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-legacy-astra-reon-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(/^model = "auto"$/m, 'model = "firerouter/astra"'),
    );
    // 0.9.8 and 0.9.9 wrote the FireRouter row with the Astra slug.
    const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    catalog.models.push({ slug: "firerouter/astra", display_name: "FireRouter", description: "Routes each user turn between GPT Astra, GPT Sol, and open models." });
    await writeFile(codexCatalogPath(home), JSON.stringify(catalog));

    const reOn = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(reOn.code, 0, reOn.stderr);
    assert.match(await readFile(configPath, "utf8"), /^model = "auto"$/m);
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
    assert.deepEqual(slugs.filter((slug) => slug.startsWith("firerouter")), []);
    assert.equal(
      parseToml(await readFile(configPath, "utf8")).tables["model_providers.fireworks-ai"].requires_openai_auth,
      true,
    );
  });

  it("a re-on drops an earlier release's FireRouter row after the user switched models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-legacy-astra-row-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345", "--model", "gpt-6.1-sol"], env)).code, 0);
    // 0.9.8 and 0.9.9 wrote the FireRouter row with the Astra slug.
    const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    catalog.models.push({ slug: "firerouter/astra", display_name: "FireRouter" });
    await writeFile(codexCatalogPath(home), JSON.stringify(catalog));

    const reOn = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(reOn.code, 0, reOn.stderr);
    assert.match(await readFile(configPath, "utf8"), /^model = "gpt-6.1-sol"$/m);
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
    assert.deepEqual(slugs.filter((slug) => slug.startsWith("firerouter")), []);
  });

  it("a model outside FireRouter still lists the OpenAI rows, with no FireRouter row", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-signin-rows-auto-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "auto"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
    assert.ok(slugs.includes("auto"));
    assert.ok(!slugs.includes("firerouter"), slugs.join(","));
    assert.ok(slugs.includes("gpt-6-astra") && slugs.includes("gpt-6-luna"), slugs.join(","));
  });

  it("a plain on with the Azure default provider is refused before FireRouter is written", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-chatgpt-login-azure-default-"));
    await mkdir(path.dirname(codexConfigPath(home)), { recursive: true });
    await writeGlobalConfig(home, { provider: "azure" });

    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "", AZURE_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no longer supports Azure\/Foundry/);
    assert.doesNotMatch(await readFile(codexConfigPath(home), "utf8").catch(() => ""), /firerouter/);
    assert.doesNotMatch(result.stdout, /GPT turns use your plan/);
  });

  it("does not attach env BYOK when firerouter is not selected", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-no-byok-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "auto"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "sk-ant-should-not-attach-12345",
      },
    );
    assert.equal(result.code, 0, result.stderr);
    const config = await readFile(codexConfigPath(home), "utf8");
    assert.match(config, /model = "auto"/);
    assert.doesNotMatch(config, /env_http_headers = \{ "x-anthropic-api-key"/);
  });

  it("a stored Claude FireRouter route drops to auto on a plain re-run, sending only the saved Anthropic key", async () => {
    const env = {
      FIREWORKS_API_KEY: "",
      ANTHROPIC_API_KEY: "sk-ant-shell-only",
      OPENAI_API_KEY: "",
      SHELL: "/bin/bash",
      ZSH_VERSION: "",
      BASH_VERSION: "5",
    };
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-firerouter-no-anthropic-"));
    await seedKeychainConfig(home, "fw_test_key_12345");
    await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-stored", openaiApiKey: "sk-example-0000" });

    const rejected = await runFireconnect(["codex", "on", "--model", "firerouter/opus"], { HOME: home, ...env });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /is no longer supported/);

    // Seed the route an earlier release wrote, then let a plain re-run drop it.
    assert.equal((await runFireconnect(["codex", "on"], { HOME: home, ...env })).code, 0);
    await writeFile(
      codexConfigPath(home),
      (await readFile(codexConfigPath(home), "utf8")).replace(/^model = "auto"$/m, 'model = "firerouter/opus"'),
    );
    let raw = await readFile(codexConfigPath(home), "utf8");
    assert.match(raw, /^model = "firerouter\/opus"$/m);

    const plain = await runFireconnect(["codex", "on"], { HOME: home, ...env });
    assert.equal(plain.code, 0, plain.stderr);
    raw = await readFile(codexConfigPath(home), "utf8");
    assert.match(raw, /^model = "auto"$/m);
    assert.match(raw, /"x-anthropic-api-key" = "sk-ant-stored"/);
    assert.doesNotMatch(raw, /ANTHROPIC_API_KEY|sk-ant-shell-only/);
    assert.doesNotMatch(raw, /x-openai-api-key|sk-example-0000/);
    const shellConfig = process.platform === "darwin" ? ".bash_profile" : ".bashrc";
    const shell = await readFile(path.join(home, shellConfig), "utf8").catch(() => "");
    assert.doesNotMatch(shell, /ANTHROPIC_API_KEY/);
  });

  it("on/off round-trip restores config.toml", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-"));
    const configDir = path.join(home, ".codex");
    await mkdir(configDir, { recursive: true });
    const configPath = codexConfigPath(home);
    const original = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
      "",
      "[[mcp_servers]]",
      'name = "test"',
      'command = "echo"',
      "",
    ].join("\n");
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /model_provider = "fireworks-ai"/);
    assert.match(enabled, /^model = "auto"$/m);
    assert.match(enabled, /\[model_providers\.fireworks-ai\]/);
    assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    assert.doesNotMatch(enabled, /\[profiles\.nexus\]/);
    const catalogPath = path.join(home, ".codex", "fireworks-model-catalog.json");
    assert.match(enabled, /requires_openai_auth = true/);
    assert.match(enabled, /"x-fireworks-api-key" = "fw_test_key_12345"/);
    assert.doesNotMatch(enabled, /experimental_bearer_token/);
    assert.doesNotMatch(enabled, /env_key = "FIREWORKS_API_KEY"/);
    assert.match(enabled, /wire_api = "responses"/);
    assert.match(enabled, /\[\[mcp_servers\]\]/);

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
    assert.equal(existsSync(catalogPath), false);
  });

  it("adds telemetry without replacing user headers and restores them on off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-headers-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = 'model_provider = "openai"\nmodel = "gpt-4.1"\n';
    await writeFile(configPath, original);

    const first = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "auto"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);
    let config = await readFile(configPath, "utf8");
    let table = parseToml(config).tables["model_providers.fireworks-ai"];
    assert.equal(table.http_headers["User-Agent"], undefined);
    assert.equal(table.http_headers["X-Title"], "Codex");
    assert.equal(
      table.http_headers["HTTP-Referer"],
      FIRECONNECT_REFERER,
    );
    assert.equal(table.http_headers["X-FireRouter-Harness"], undefined);
    assert.equal(table.http_headers["Fireworks-Use-Case"], undefined);

    config = config.replace(
      /^http_headers = .*$/m,
      "http_headers = { User-Agent = 'custom-codex/1.0', X-User-Trace = 'keep', X-FireRouter-Harness = 'codex', Fireworks-Use-Case = 'coding', HTTP-Referer = 'fireconnect/v0.7.0' }\n"
        + "env_http_headers = { X-User-Env = 'USER_ENV', x-anthropic-api-key = 'OLD_ANTHROPIC' }",
    );
    await writeFile(configPath, config);

    const repeat = await runFireconnect(
      ["codex", "on"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(repeat.code, 0, repeat.stderr);
    table = parseToml(await readFile(configPath, "utf8"))
      .tables["model_providers.fireworks-ai"];
    assert.equal(table.http_headers["X-User-Trace"], "keep");
    assert.equal(table.http_headers["User-Agent"], "custom-codex/1.0");
    assert.equal(table.http_headers["X-Title"], "Codex");
    assert.equal(
      table.http_headers["HTTP-Referer"],
      FIRECONNECT_REFERER,
    );
    assert.equal(table.http_headers["X-FireRouter-Harness"], undefined);
    assert.equal(table.http_headers["Fireworks-Use-Case"], undefined);
    assert.equal(table.env_http_headers["X-User-Env"], "USER_ENV");
    assert.equal(table.env_http_headers["x-anthropic-api-key"], undefined);
    assert.equal(table.env_http_headers["x-openai-api-key"], undefined);
    assert.equal(table.http_headers["x-fireworks-api-key"], "fw_test_key_12345");

    const off = await runFireconnect(
      ["codex", "off"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("on resolves API key from keychain when env is unset", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-global-"));
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await seedKeychainConfig(home, "fw_test_key_12345");

      const onResult = await runFireconnect(["codex", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(onResult.code, 0, onResult.stderr);
      assert.match(onResult.stdout, /Codex → Fireworks · auto/);

      const configPath = codexConfigPath(home);
      const enabled = await readFile(configPath, "utf8");
      assert.match(enabled, /model_provider = "fireworks-ai"/);
      assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    });
  });

  it("on reuses a harness-local bearer token when global config and env are unset", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-harness-literal-"));
      await writeCodexConfig(home, { apiKey: FW_CODEX_KEY, envRef: false });

      const onResult = await runFireconnect(["codex", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(onResult.code, 0, onResult.stderr);

      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /"x-fireworks-api-key" = "fw_test_codex_key_00000000000000"/);
      assert.doesNotMatch(config, /experimental_bearer_token/);
      assert.doesNotMatch(config, /env_key = "FIREWORKS_API_KEY"/);

      const exportResult = await runFireconnect(["key", "export"], {
        HOME: home,
        FIREWORKS_API_KEY: "",
      });
      assert.equal(exportResult.code, 0, exportResult.stderr);
      assert.equal(exportResult.stdout.trim(), FW_CODEX_KEY);
    });
  });

  it("on with env only writes the literal key into the Fireworks key header", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-env-on-"));
      await mkdir(path.join(home, ".codex"), { recursive: true });

      const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
      const onResult = await runFireconnect(["codex", "on", "--model", "auto"], env);
      assert.equal(onResult.code, 0);
      assert.match(onResult.stdout, /Codex → Fireworks · auto/);

      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /"x-fireworks-api-key" = "fw_test_key_12345"/);
      assert.doesNotMatch(config, /experimental_bearer_token/);
      assert.doesNotMatch(config, /env_key = "FIREWORKS_API_KEY"/);
    });
  });

  it("on with a literal key header does not tighten config.toml permissions", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-env-perms-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);

    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
    const onResult = await runFireconnect(["codex", "on", "--model", "auto"], env);
    assert.equal(onResult.code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /"x-fireworks-api-key" = "fw_test_key_12345"/);
    assert.doesNotMatch(enabled, /env_key = "FIREWORKS_API_KEY"/);

    const st = await stat(configPath);
    assert.equal(st.mode & 0o700, 0o600, "config.toml should remain owner-readable/writable");
  });

  it("off strips routing when backup is missing or contains Fireworks config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-backup-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);
    const original = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
    ].join("\n") + "\n";
    await writeFile(configPath, original);

    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    assert.equal(
      (await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345", "--model", "auto"], env)).code,
      0,
    );

    const backupPath = codexBackupPath(codexDataDir(home), configPath);
    await unlink(backupPath);

    const legacyCanonical = (await readFile(configPath, "utf8")).replace(
      'model = "kimi-fast-latest"',
      'model = "accounts/fireworks/routers/kimi-fast-latest"',
    );
    await writeFile(configPath, legacyCanonical);
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);
    await assert.rejects(access(backupPath));
    assert.match(await readFile(configPath, "utf8"), /model = "auto"/);

    let offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup|was not connected/);

    let restored = await readFile(configPath, "utf8");
    assert.doesNotMatch(restored, /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(restored, /\[model_providers\.fireworks-ai\]/);

    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);
    const fireworksConfig = await readFile(configPath, "utf8");
    await writeJson(backupPath, {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: fireworksConfig },
    });

    offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup|was not connected/);

    restored = await readFile(configPath, "utf8");
    assert.doesNotMatch(restored, /model_provider = "fireworks-ai"/);
    await assert.rejects(access(backupPath));
  });

  it("on snapshots and off restores when user already has fireworks-ai provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-existing-provider-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);
    const original = [
      'model_provider = "fireworks-ai"',
      'model = "accounts/fireworks/models/custom-model"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "My Fireworks"',
      'base_url = "https://custom.example/v1"',
      'env_key = "FIREWORKS_API_KEY"',
      "",
    ].join("\n");
    await writeFile(configPath, original);

    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    assert.match(enabled, /base_url = "https:\/\/api\.fireworks\.ai\/inference\/v1"/);

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });
});
