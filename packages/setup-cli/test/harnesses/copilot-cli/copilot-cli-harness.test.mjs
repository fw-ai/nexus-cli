import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  copilotCliModelIdFromSelection,
  copilotCliSelectionId,
  copilotProvidersPath,
  copilotSettingsPath,
  deselectCopilotCliModel,
  disableCopilotCli,
  enableCopilotCli,
  readCopilotCliState,
  selectCopilotCliModel,
} from "../../../lib/harnesses/copilot-cli/config.mjs";
import {
  runCli,
  runCliJson,
  runFireconnect,
  withTempHome,
  FW_OPENCODE_KEY,
} from "../../helpers.mjs";

async function withCliDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-copilot-cli-"));
  try {
    await fn({
      providersPath: path.join(dir, "providers.json"),
      settingsPath: path.join(dir, "settings.json"),
      dataDir: path.join(dir, "data"),
      dir,
    });
  } finally {
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
}

describe("copilot-cli config", () => {
  it("qualifies selection ids with the provider name", () => {
    // A bare id is rejected by the CLI ("Model … is not available") and falls
    // back to another model, so the prefix is not cosmetic.
    assert.equal(copilotCliSelectionId("glm-latest"), "fireworks/glm-latest");
    assert.equal(copilotCliModelIdFromSelection("fireworks/glm-latest"), "glm-latest");
    assert.equal(copilotCliModelIdFromSelection("other/glm-latest"), "");
  });

  it("resolves providers.json and settings.json side by side, honoring COPILOT_HOME", () => {
    const home = "/tmp/fake-home";
    assert.equal(copilotProvidersPath({ home }), path.join(home, ".copilot", "providers.json"));
    assert.equal(copilotSettingsPath({ home }), path.join(home, ".copilot", "settings.json"));
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = "/tmp/relocated";
    try {
      assert.equal(copilotProvidersPath({ home }), path.join("/tmp/relocated", "providers.json"));
      assert.equal(copilotSettingsPath({ home }), path.join("/tmp/relocated", "settings.json"));
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
    }
  });

  it("preserves the user's own providers and models, and restores them on off", async () => {
    await withCliDir(async ({ providersPath, dataDir }) => {
      const { writeFile, readFile } = await import("node:fs/promises");
      // Hand-formatted so the byte-for-byte restore is meaningful.
      const original = '{\n  "providers": [ { "name": "mine", "baseUrl": "https://example.test" } ],\n  "models": [ { "id": "m1", "provider": "mine" } ]\n}\n';
      await writeFile(providersPath, original);

      await enableCopilotCli({
        providersPath,
        dataDir,
        apiKey: FW_OPENCODE_KEY,
        models: [{ id: "glm-5p2", displayName: "GLM 5.2", maxPromptTokens: 1000, maxOutputTokens: 100 }],
      });

      const written = JSON.parse(await readFile(providersPath, "utf8"));
      assert.deepEqual(written.providers.map((p) => p.name).sort(), ["fireworks", "mine"]);
      assert.deepEqual(written.models.map((m) => m.id).sort(), ["glm-5p2", "m1"]);

      assert.equal(await disableCopilotCli({ providersPath, dataDir }), "restored");
      assert.equal(await readFile(providersPath, "utf8"), original, "must restore byte-for-byte");
    });
  });

  it("re-on after a lost backup doesn't snapshot Nexus's own config as the user's", async () => {
    await withCliDir(async ({ providersPath, settingsPath, dataDir }) => {
      const { writeFile, readFile, rm } = await import("node:fs/promises");
      await writeFile(providersPath, '{\n  "providers": [ { "name": "mine", "baseUrl": "https://example.test" } ],\n  "models": [ { "id": "m1", "provider": "mine" } ]\n}\n');
      await writeFile(settingsPath, JSON.stringify({ theme: "dark", model: "mine/m1" }, null, 2));
      const models = [{ id: "glm-latest", displayName: "GLM Latest" }];
      await enableCopilotCli({ providersPath, dataDir, apiKey: FW_OPENCODE_KEY, models });
      await selectCopilotCliModel({ settingsPath, dataDir, selectionId: "fireworks/glm-latest" });

      await rm(dataDir, { recursive: true, force: true });
      await enableCopilotCli({ providersPath, dataDir, apiKey: FW_OPENCODE_KEY, models });
      await selectCopilotCliModel({ settingsPath, dataDir, selectionId: "fireworks/glm-latest" });

      assert.equal(await disableCopilotCli({ providersPath, dataDir }), "stripped");
      const providers = JSON.parse(await readFile(providersPath, "utf8"));
      assert.deepEqual(providers.providers.map((p) => p.name), ["mine"]);
      assert.deepEqual(providers.models.map((m) => m.id), ["m1"]);
      assert.doesNotMatch(await readFile(providersPath, "utf8"), new RegExp(FW_OPENCODE_KEY));

      assert.equal(await deselectCopilotCliModel({ settingsPath, dataDir }), "stripped");
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.model, undefined);
      assert.equal(settings.theme, "dark");
    });
  });

  it("declares vision only where the model carries it", async () => {
    await withCliDir(async ({ providersPath, dataDir }) => {
      const { readFile } = await import("node:fs/promises");
      await enableCopilotCli({
        providersPath,
        dataDir,
        apiKey: FW_OPENCODE_KEY,
        models: [
          { id: "kimi-latest", displayName: "Kimi Latest", vision: true },
          { id: "glm-latest", displayName: "GLM Latest", vision: false },
        ],
      });
      const cfg = JSON.parse(await readFile(providersPath, "utf8"));
      assert.equal(cfg.models.find((m) => m.id === "kimi-latest").capabilities.supports.vision, true);
      assert.equal(cfg.models.find((m) => m.id === "glm-latest").capabilities.supports.vision, undefined);
    });
  });

  it("selects a model in settings.json and hands it back on off", async () => {
    await withCliDir(async ({ settingsPath, dataDir }) => {
      const { writeFile, readFile } = await import("node:fs/promises");
      await writeFile(settingsPath, JSON.stringify({ theme: "dark", effortLevel: "high" }, null, 2));

      await selectCopilotCliModel({ settingsPath, dataDir, selectionId: "fireworks/glm-latest" });
      const after = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(after.model, "fireworks/glm-latest");
      assert.equal(after.theme, "dark", "unrelated settings must survive");

      assert.equal(await deselectCopilotCliModel({ settingsPath, dataDir }), "restored");
      const restored = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(restored.model, undefined);
      assert.equal(restored.theme, "dark");
    });
  });

  it("reports configured state and the selection", async () => {
    await withCliDir(async ({ providersPath, settingsPath, dataDir }) => {
      assert.equal((await readCopilotCliState(providersPath)).configured, false);
      await enableCopilotCli({
        providersPath, dataDir, apiKey: FW_OPENCODE_KEY,
        models: [{ id: "glm-5p2", displayName: "GLM 5.2" }],
      });
      await selectCopilotCliModel({ settingsPath, dataDir, selectionId: "fireworks/glm-5p2" });
      const state = await readCopilotCliState(providersPath, settingsPath);
      assert.equal(state.configured, true);
      assert.equal(state.apiKey, FW_OPENCODE_KEY);
      assert.deepEqual(state.models, ["glm-5p2"]);
      assert.equal(state.selectedModel, "fireworks/glm-5p2");
    });
  });
});

describe("copilot-cli CLI", () => {
  it("help points at the CLI and names the other product", async () => {
    const { stdout } = await runCli(["copilot-cli", "help"]);
    assert.match(stdout, /Copilot CLI/);
    assert.match(stdout, /--providers-path/);
    assert.match(stdout, /copilot-app/);
  });

  it("main help lists both products", async () => {
    const { stdout, code } = await runCli(["help"]);
    assert.equal(code, 0);
    assert.match(stdout, /copilot-app\s+GitHub Copilot desktop app/);
    assert.match(stdout, /copilot-cli\s+GitHub Copilot CLI/);
  });

  it("bare `copilot` is ambiguous, with both products named", async () => {
    const { code, stdout, stderr } = await runCli(["copilot", "on"]);
    assert.equal(code, 1);
    assert.match(stdout + stderr, /ambiguous/);
    assert.match(stdout + stderr, /copilot-app/);
    assert.match(stdout + stderr, /copilot-cli/);
  });

  it("status --json reports off state on a bare home", async () => {
    await withTempHome("copilot-cli-status-", async (home) => {
      const { json: payload } = await runCliJson(["copilot-cli", "status", "--json"], { home });
      assert.equal(payload.harness, "copilot-cli");
      assert.equal(payload.provider, "none");
      assert.equal(payload.enabled, false);
    });
  });

  it("on then off round-trips providers.json and settings.json", async () => {
    await withTempHome("copilot-cli-roundtrip-", async (home) => {
      const on = await runFireconnect(["copilot-cli", "on"], {
        HOME: home,
        FIREWORKS_API_KEY: FW_OPENCODE_KEY,
      });
      assert.equal(on.code, 0, on.stderr);
      assert.match(on.stdout, /Copilot CLI → Fireworks/);

      const { readFile } = await import("node:fs/promises");
      const providersPath = copilotProvidersPath({ home });
      const written = JSON.parse(await readFile(providersPath, "utf8"));
      assert.deepEqual(written.providers.map((p) => p.name), ["fireworks"]);

      const { json: payload } = await runCliJson(["copilot-cli", "status", "--json"], { home });
      assert.equal(payload.provider, "fireworks");
      assert.ok(payload.selectedModel?.startsWith("fireworks/"));

      const off = await runFireconnect(["copilot-cli", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);
      const { json: after } = await runCliJson(["copilot-cli", "status", "--json"], { home });
      assert.equal(after.provider, "none");
    });
  });

  it("rejects flags meant for the other product", async () => {
    await withTempHome("copilot-cli-flags-", async (home) => {
      const { code, stderr } = await runCli(["copilot-cli", "status", "--db-path", "/tmp/x.db"], { home });
      assert.equal(code, 1);
      assert.match(stderr, /--db-path is supported only by Cursor and the Copilot app/);
    });
  });
});
