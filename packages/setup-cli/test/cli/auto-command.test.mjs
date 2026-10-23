import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../../lib/cli/parse-args.mjs";
import {
  globalConfigPath,
  readGlobalConfig,
  writeGlobalConfig,
} from "../../lib/config/global-config.mjs";
import {
  AUTO_UNSUPPORTED_HARNESSES,
  NEXUS_PROVIDERS_HEADER,
  autoHarnessSupported,
  autoProviderKeysInScope,
  formatAutoProviders,
  nexusProvidersHeaders,
  normalizeAutoProviders,
  parseAutoProviders,
} from "../../lib/config/auto-providers.mjs";
import {
  buildClaudeCustomHeaders,
  stripManagedCustomHeaderLines,
} from "../../lib/firerouter/core.mjs";
import { buildFireworksSettings } from "../../lib/harnesses/claude/core.mjs";
import { resolveClaudeModelMapping } from "../../lib/harnesses/claude/model-profile.mjs";
import { enableOpencodeFireworks } from "../../lib/harnesses/opencode/core.mjs";
import { engineOn } from "../../lib/harness/engine.mjs";
import { withFireconnectRequestHeaders } from "../../lib/harnesses/vscode/request-headers.mjs";
import { runFireconnect, withTempHome } from "../helpers.mjs";

describe("auto providers (pure parsing/storage)", () => {
  it("parses fireworks and dedupes", () => {
    assert.deepEqual(parseAutoProviders(" fireworks ,fireworks"), ["fireworks"]);
    assert.deepEqual(parseAutoProviders("FIREWORKS"), ["fireworks"]);
  });

  it("rejects unknown providers and empty segments", () => {
    assert.throws(() => parseAutoProviders("acme"), /unknown provider: acme/);
    assert.throws(() => parseAutoProviders("fireworks,,acme"), /comma-separated list/);
    assert.throws(() => parseAutoProviders(""), /comma-separated list/);
  });

  it("normalizes stored values; unknown-only reads as empty, never unset", () => {
    assert.deepEqual(normalizeAutoProviders(["junk", "fireworks"]), ["fireworks"]);
    assert.deepEqual(normalizeAutoProviders(["junk"]), []);
    assert.deepEqual(normalizeAutoProviders([]), []);
    assert.equal(normalizeAutoProviders("fireworks"), null);
    assert.equal(normalizeAutoProviders(null), null);
    // Empty scope sends neither the scope header nor saved provider keys.
    assert.deepEqual(nexusProvidersHeaders(normalizeAutoProviders(["junk"])), {});
    assert.deepEqual(
      autoProviderKeysInScope({
        auto: { providers: ["junk"] },
        anthropicApiKey: "sk-ant-example-0000",
        openaiApiKey: "sk-example-0000",
      }),
      { anthropicKey: "", openaiKey: "" },
    );
  });

  it("knows which harnesses cannot carry the setting yet", () => {
    assert.deepEqual(
      AUTO_UNSUPPORTED_HARNESSES.map(({ id }) => id),
      ["cursor"],
    );
    for (const { id } of AUTO_UNSUPPORTED_HARNESSES) {
      assert.equal(autoHarnessSupported(id), false, id);
    }
    for (const id of ["claude", "claude-desktop", "deepseek", "opencode", "codex", "pi", "vscode", "copilot-app", "copilot-cli"]) {
      assert.equal(autoHarnessSupported(id), true, id);
    }
  });

  it("formats the header value and headers map", () => {
    assert.equal(formatAutoProviders(["fireworks"]), "fireworks");
    assert.equal(formatAutoProviders(null), "");
    assert.deepEqual(nexusProvidersHeaders(["fireworks"]), { [NEXUS_PROVIDERS_HEADER]: "fireworks" });
    assert.deepEqual(nexusProvidersHeaders(null), {});
  });

  it("round-trips through global config and survives unrelated writes", async () => {
    await withTempHome("auto-config", async (home) => {
      await writeGlobalConfig(home, { auto: { providers: ["fireworks"] } });
      let config = await readGlobalConfig(home);
      assert.deepEqual(config.auto.providers, ["fireworks"]);

      await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-test-12345" });
      config = await readGlobalConfig(home);
      assert.deepEqual(config.auto.providers, ["fireworks"]);
      assert.equal(config.anthropicApiKey, "sk-ant-test-12345");

      await writeGlobalConfig(home, { auto: { providers: null } });
      config = await readGlobalConfig(home);
      assert.equal(config.auto.providers, null);
    });
  });
});

describe("nexus auto (CLI)", () => {
  it("shows and explains the default when nothing is stored", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-auto-show-"));
    const result = await runFireconnect(["auto"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Providers:\s+default$/m);
    assert.match(result.stdout, /Auto-selects the best model for each turn, based on your setup\./);
    assert.match(result.stdout, /Tips:/);
    assert.match(result.stdout, /Limit the models to Fireworks-only with nexus auto --providers fireworks/);
    assert.match(result.stdout, /Your account's model restrictions always apply first/);
    assert.doesNotMatch(result.stdout, /not yet supported/);
    assert.match(result.stdout, /To reset, use nexus auto --reset/);
    assert.doesNotMatch(result.stdout, /haven't narrowed/);
    assert.doesNotMatch(result.stdout, /x-nexus-providers/);
    // User-facing copy: house style is no emdashes, and the transport
    // detail stays out of what users read.
    assert.doesNotMatch(result.stdout, /—/);
    assert.match(result.stdout, /nexus auto --providers fireworks/);

    const json = await runFireconnect(["auto", "--json"], { HOME: home });
    assert.equal(JSON.parse(json.stdout).providers, null);
    assert.match(JSON.parse(json.stdout).behavior, /based on your setup/);
  });

  it("--providers fireworks stores fireworks and prints the re-on step", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-auto-fwonly-"));
    const result = await runFireconnect(["auto", "--providers", "fireworks"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /providers saved: fireworks/);
    assert.match(result.stdout, /Your account's model restrictions always apply first/);
    assert.doesNotMatch(result.stdout, /x-nexus-providers/);
    assert.match(result.stdout, /One more step: this takes effect only once you run your/);
    assert.match(result.stdout, /nexus <harness>\s*$/m);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.deepEqual(config.auto.providers, ["fireworks"]);

    const shown = await runFireconnect(["auto"], { HOME: home });
    assert.match(shown.stdout, /Providers:\s+fireworks/);
    assert.match(shown.stdout, /Your account's model restrictions always apply first/);
  });

  it("names the re-on command for each enabled harness", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-auto-reon-"));
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true }, opencode: { enabled: false } } });
    const result = await runFireconnect(["auto", "--providers", "fireworks"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /nexus claude\s*$/m);
    assert.doesNotMatch(result.stdout, /nexus opencode/);
  });

  it("shows enabled-but-unsupported harnesses as not supported, with no re-run step", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-auto-unsupported-"));
    await writeGlobalConfig(home, {
      harnesses: {
        cursor: { enabled: true },
        deepseek: { enabled: true },
        "claude-desktop": { enabled: true },
        pi: { enabled: true },
      },
    });
    const result = await runFireconnect(["auto", "--providers", "fireworks"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /nexus pi\s*$/m);
    assert.match(result.stdout, /nexus claude-desktop\s*$/m);
    assert.match(result.stdout, /nexus deepseek\s*$/m);
    assert.match(result.stdout, /Not yet supported on Cursor IDE/);
    assert.match(result.stdout, /nothing to re-run/);
    assert.doesNotMatch(result.stdout, /nexus cursor/);

    const shown = await runFireconnect(["auto"], { HOME: home });
    assert.match(shown.stdout, /not yet supported by Cursor IDE/);
    assert.doesNotMatch(shown.stdout, /DeepSeek, or Claude Desktop/);
  });

  it("--providers stores fireworks; --reset restores the default", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-auto-providers-"));
    const set = await runFireconnect(
      ["auto", "--providers", "fireworks,fireworks"],
      { HOME: home },
    );
    assert.equal(set.code, 0, set.stderr);
    let config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.deepEqual(config.auto.providers, ["fireworks"]);

    const reset = await runFireconnect(["auto", "--reset"], { HOME: home });
    assert.equal(reset.code, 0, reset.stderr);
    assert.match(reset.stdout, /back to the default/);
    assert.match(reset.stdout, /Auto-selects the best model for each turn, based on your setup\./);
    assert.doesNotMatch(reset.stdout, /x-nexus-providers/);
    config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.auto.providers, null);
  });

  it("--json reports providers, fireworksOnly, and behavior", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-auto-json-"));
    await runFireconnect(["auto", "--providers", "fireworks"], { HOME: home });
    const result = await runFireconnect(["auto", "--json"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      providers: ["fireworks"],
      keys: { anthropic: false, openai: false },
      keysSent: { anthropic: false, openai: false },
      fireworksOnly: true,
      behavior: "auto routes only to the listed providers; your account's model restrictions always apply first",
      providerKeys: {
        outcome: "no-key",
        anthropic: { state: "not-connected", keyHint: "" },
        openai: { state: "not-connected", keyHint: "" },
      },
    });
  });

  it("rejects unknown providers, conflicting flags, and misplaced flags", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-auto-errors-"));
    const bad = await runFireconnect(["auto", "--providers", "foo"], { HOME: home });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /unknown provider: foo/);

    assert.throws(
      () => parseCli(["auto", "--fireworks-only"]),
      /Unknown argument: --fireworks-only\. Use --providers fireworks instead\./,
    );

    assert.throws(
      () => parseCli(["claude", "on", "--providers", "fireworks"]),
      /--providers applies only to `nexus auto`/,
    );
    assert.throws(
      () => parseCli(["configure", "--reset"]),
      /--reset applies only to `nexus auto`/,
    );
    assert.throws(
      () => parseCli(["auto", "status"]),
      /auto does not accept positional arguments/,
    );
  });
});

describe("x-nexus-providers on harness on", () => {
  it("rides Claude custom headers and is stripped as a managed line", () => {
    const headers = buildClaudeCustomHeaders({
      fireworksKey: "fw_test_key",
      nexusProviders: "fireworks",
    });
    assert.match(headers, /x-nexus-providers: fireworks/);
    assert.doesNotMatch(stripManagedCustomHeaderLines(headers), /x-nexus-providers/);

    const { settings } = buildFireworksSettings({ env: {} }, {
      apiKey: "fw_test_claude_key_00000000000000",
      mapping: resolveClaudeModelMapping(),
      nexusProviders: "fireworks",
    });
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-nexus-providers: fireworks/);
  });

  it("is written by OpenCode on and removed by a re-on without it", async () => {
    await withTempHome("auto-opencode", async (home) => {
      const configPath = path.join(home, "opencode.json");
      const dataDir = path.join(home, "data");
      const base = {
        configPath,
        dataDir,
        apiKey: "fw_test_key_12345",
        effectiveApiKey: "fw_test_key_12345",
        modelId: "auto",
      };
      await enableOpencodeFireworks({
        ...base,
        byokHeaders: { [NEXUS_PROVIDERS_HEADER]: "fireworks" },
      });
      let config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(
        config.provider["fireworks-ai"].options.headers[NEXUS_PROVIDERS_HEADER],
        "fireworks",
      );

      await enableOpencodeFireworks({ ...base, byokHeaders: {} });
      config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(
        config.provider["fireworks-ai"].options.headers?.[NEXUS_PROVIDERS_HEADER],
        undefined,
      );
    });
  });

  it("engine on merges the stored scope into both header channels", async () => {
    await withTempHome("auto-engine", async (home) => {
      let captured;
      const profile = {
        id: "opencode",
        label: "OpenCode",
        resolveKey: async () => "",
        paths: () => ({}),
        keyEnvRef: "{env:FIREWORKS_API_KEY}",
        firerouter: { byok: "none", autoCatalog: true },
        telemetryHeaders: true,
        resolveOnKey: async () => ({ apiKeyRef: "fw_test_key", effectiveKey: "fw_test_key" }),
        enable: async (args) => {
          captured = args;
          return { model: "auto", modelsAdded: ["auto"] };
        },
      };
      const ctx = { home, main: "auto", quiet: true };

      await writeGlobalConfig(home, { auto: { providers: ["fireworks"] } });
      await engineOn(profile, ctx);
      assert.equal(captured.byokHeaders[NEXUS_PROVIDERS_HEADER], "fireworks");
      assert.equal(captured.telemetryHeaders[NEXUS_PROVIDERS_HEADER], "fireworks");

      await writeGlobalConfig(home, { auto: { providers: null } });
      await engineOn(profile, ctx);
      assert.equal(captured.byokHeaders[NEXUS_PROVIDERS_HEADER], undefined);
      assert.equal(captured.telemetryHeaders[NEXUS_PROVIDERS_HEADER], undefined);
    });
  });

  it("engine on warns when a stored scope can't apply in the harness", async () => {
    await withTempHome("auto-engine-unsupported-", async (home) => {
      const profile = {
        id: "cursor",
        label: "Cursor IDE",
        resolveKey: async () => "",
        paths: () => ({}),
        keyEnvRef: "{env:FIREWORKS_API_KEY}",
        firerouter: null,
        restartHint: () => {},
        resolveOnKey: async () => ({ apiKeyRef: "fw_test_key", effectiveKey: "fw_test_key" }),
        enable: async () => ({ model: "nexus/auto", modelsAdded: ["nexus/auto"] }),
      };
      const lines = [];
      const original = console.log;
      console.log = (...args) => lines.push(args.join(" "));
      try {
        await writeGlobalConfig(home, { auto: { providers: ["fireworks"] } });
        await engineOn(profile, { home, main: "auto" });
        assert.ok(lines.some((line) => /provider scope doesn't apply in Cursor IDE/.test(line)), lines.join("\n"));

        lines.length = 0;
        await writeGlobalConfig(home, { auto: { providers: null } });
        await engineOn(profile, { home, main: "auto" });
        assert.ok(!lines.some((line) => /provider scope doesn't apply/.test(line)), lines.join("\n"));
      } finally {
        console.log = original;
      }
    });
  });

  it("attaches to VS Code auto models and is stripped on the next on", () => {
    const withHeader = withFireconnectRequestHeaders(
      { id: "auto" },
      { byokHeaders: { [NEXUS_PROVIDERS_HEADER]: "fireworks" } },
    );
    assert.equal(withHeader.requestHeaders[NEXUS_PROVIDERS_HEADER], "fireworks");

    const without = withFireconnectRequestHeaders(
      { id: "auto", requestHeaders: { [NEXUS_PROVIDERS_HEADER]: "fireworks" } },
      { byokHeaders: {} },
    );
    assert.equal(without.requestHeaders?.[NEXUS_PROVIDERS_HEADER], undefined);
  });
});
