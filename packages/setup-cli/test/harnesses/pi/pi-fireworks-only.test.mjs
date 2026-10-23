import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PI_DATA_RELATIVE_DIR,
  piAuthPath,
  piModelsPath,
  piSettingsPath,
} from "../../../lib/harnesses/pi/core.mjs";
import { refreshPiCatalogForHome } from "../../../lib/harnesses/pi/upgrade-migrations.mjs";
import { mockServerlessModel, runFireconnect } from "../../helpers.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";

const KEY = "fw_test_key_12345";

const USER_SETTINGS = {
  theme: "dark",
  defaultProvider: "ollama",
  defaultModel: "qwen3:8b",
  enabledModels: ["ollama/*", "my-server/coder-32b"],
};
const USER_MODELS = {
  providers: {
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "ollama",
      models: [{ id: "qwen3:8b" }],
    },
    "my-server": {
      baseUrl: "http://coder.example.com/v1",
      api: "openai-completions",
      apiKey: "sk-secret-server",
      models: [{ id: "coder-32b" }],
    },
  },
};
const USER_AUTH = { anthropic: { type: "api_key", key: "sk-ant-secret" } };

async function seedUserPi() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-fw-only-"));
  await mkdir(path.join(home, ".pi/agent"), { recursive: true });
  await writeFile(piSettingsPath(home), `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
  await writeFile(piModelsPath(home), `${JSON.stringify(USER_MODELS, null, 2)}\n`);
  await writeFile(piAuthPath(home), `${JSON.stringify(USER_AUTH, null, 2)}\n`);
  return home;
}

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

async function readAllUnder(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const contents = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      contents.push(await readFile(path.join(entry.parentPath ?? entry.path, entry.name), "utf8"));
    }
  }
  return contents.join("\n");
}

function legacyBackupPath(home, filePath, label) {
  const key = createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);
  return path.join(home, PI_DATA_RELATIVE_DIR, `${label}-backup.${key}.json`);
}

describe("pi harness only touches the fireworks provider", () => {
  it("on only touches the fireworks keys; off restores each file byte-for-byte", async () => {
    const home = await seedUserPi();
    const originals = await Promise.all(
      [piSettingsPath(home), piModelsPath(home), piAuthPath(home)].map((p) => readFile(p, "utf8")),
    );
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    const on = await runFireconnect(["pi", "on", "--api-key", KEY], env);
    assert.equal(on.code, 0, on.stderr);

    const settings = await readJson(piSettingsPath(home));
    assert.equal(settings.defaultProvider, "fireworks");
    assert.deepEqual(settings.enabledModels, [...USER_SETTINGS.enabledModels, "fireworks/**"]);
    const models = await readJson(piModelsPath(home));
    assert.deepEqual(models.providers.ollama, USER_MODELS.providers.ollama);
    assert.deepEqual(models.providers["my-server"], USER_MODELS.providers["my-server"]);
    const auth = await readJson(piAuthPath(home));
    assert.deepEqual(auth.anthropic, USER_AUTH.anthropic);
    assert.equal(auth.fireworks.key, KEY);

    const off = await runFireconnect(["pi", "off"], env);
    assert.equal(off.code, 0, off.stderr);
    const restored = await Promise.all(
      [piSettingsPath(home), piModelsPath(home), piAuthPath(home)].map((p) => readFile(p, "utf8")),
    );
    assert.deepEqual(restored, originals);
    assert.deepEqual(await readAllUnder(path.join(home, PI_DATA_RELATIVE_DIR)), "", "snapshots are removed");
  });

  it("re-on after the user switched Pi to another provider keeps the first snapshot", async () => {
    const home = await seedUserPi();
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    await runFireconnect(["pi", "on", "--api-key", KEY], env);
    const settings = await readJson(piSettingsPath(home));
    await writeFile(piSettingsPath(home), `${JSON.stringify({
      ...settings,
      defaultProvider: "my-server",
      defaultModel: "coder-32b",
    }, null, 2)}\n`);

    await runFireconnect(["pi", "on"], env);
    assert.equal((await readJson(piSettingsPath(home))).defaultProvider, "fireworks");
    await runFireconnect(["pi", "off"], env);

    assert.deepEqual(await readJson(piSettingsPath(home)), USER_SETTINGS);
    assert.deepEqual(await readJson(piAuthPath(home)), USER_AUTH);
  });

  it("off leaves a Pi the user pointed at Fireworks themselves alone when Nexus never connected", async () => {
    const home = await seedUserPi();
    const own = `${JSON.stringify({ defaultProvider: "fireworks", defaultModel: "accounts/fireworks/routers/sample-latest" })}\n`;
    await writeFile(piSettingsPath(home), own);
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    const off = await runFireconnect(["pi", "off"], env);
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /was not connected/);
    assert.equal(await readFile(piSettingsPath(home), "utf8"), own);
    const status = JSON.parse((await runFireconnect(["pi", "status", "--json"], env)).stdout);
    assert.notEqual(status.provider, "fireworks");
  });

  it("keeps what Pi or the user changed while on, and still removes Nexus's key", async () => {
    const home = await seedUserPi();
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    await runFireconnect(["pi", "on", "--api-key", KEY], env);
    // Pi rewrites auth.json itself (OAuth refresh, /login) and settings.json.
    const auth = await readJson(piAuthPath(home));
    auth.anthropic = { type: "oauth", refresh: "rotated-refresh", access: "a", expires: 1 };
    await writeFile(piAuthPath(home), `${JSON.stringify(auth, null, 2)}\n`);
    const settings = await readJson(piSettingsPath(home));
    await writeFile(piSettingsPath(home), `${JSON.stringify({ ...settings, defaultThinkingLevel: "high" }, null, 2)}\n`);

    await runFireconnect(["pi", "off"], env);
    assert.deepEqual(await readJson(piAuthPath(home)), {
      anthropic: { type: "oauth", refresh: "rotated-refresh", access: "a", expires: 1 },
    });
    assert.deepEqual(await readJson(piSettingsPath(home)), { ...USER_SETTINGS, defaultThinkingLevel: "high" });
    assert.deepEqual(await readJson(piModelsPath(home)), USER_MODELS, "untouched models.json is restored as is");
  });

  it("a model switch inside Pi plus a lost data dir doesn't leave Nexus's key behind", async () => {
    const home = await seedUserPi();
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    await runFireconnect(["pi", "on", "--api-key", KEY], env);
    const settings = await readJson(piSettingsPath(home));
    await writeFile(piSettingsPath(home), `${JSON.stringify({ ...settings, defaultProvider: "ollama", defaultModel: "qwen3:8b" }, null, 2)}\n`);
    await rm(path.join(home, PI_DATA_RELATIVE_DIR), { recursive: true, force: true });

    await runFireconnect(["pi", "on", "--api-key", KEY], env);
    await runFireconnect(["pi", "off"], env);
    assert.deepEqual(await readJson(piAuthPath(home)), USER_AUTH);
    assert.equal((await readJson(piModelsPath(home))).providers.fireworks, undefined);
    assert.equal((await readJson(piSettingsPath(home))).defaultProvider, "ollama");
  });

  it("off restores a file that vanished while on from its snapshot", async () => {
    const home = await seedUserPi();
    const original = await readFile(piSettingsPath(home), "utf8");
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    await runFireconnect(["pi", "on", "--api-key", KEY], env);
    await rm(piSettingsPath(home));
    await runFireconnect(["pi", "off"], env);
    assert.equal(await readFile(piSettingsPath(home), "utf8"), original);
  });

  it("upgrade without a cached catalog still drops the router glob and rows Pi carries", async () => {
    const home = await seedUserPi();
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    await runFireconnect(["pi", "on", "--api-key", KEY], env);
    const settings = await readJson(piSettingsPath(home));
    await writeFile(piSettingsPath(home), `${JSON.stringify({
      ...settings,
      enabledModels: ["fireworks/accounts/fireworks/routers/*", "fireworks/auto"],
    }, null, 2)}\n`);
    const models = await readJson(piModelsPath(home));
    models.providers.fireworks.models.push({ id: "accounts/fireworks/routers/sample-latest", name: "Sample" });
    await writeFile(piModelsPath(home), `${JSON.stringify(models, null, 2)}\n`);

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    setServerlessCatalogSnapshot(null);
    try {
      assert.equal(await refreshPiCatalogForHome(home), true);
    } finally {
      process.env.HOME = prevHome;
    }
    assert.equal((await readJson(piSettingsPath(home))).enabledModels, undefined);
    assert.deepEqual((await readJson(piModelsPath(home))).providers.fireworks.models.map((m) => m.id), ["auto"]);
  });

  it("upgrade drops a FireRouter default and keeps its provider-key headers for Nexus Auto", async () => {
    const home = await seedUserPi();
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    await runFireconnect(["pi", "on", "--api-key", KEY], env);
    const settings = await readJson(piSettingsPath(home));
    await writeFile(piSettingsPath(home), `${JSON.stringify({
      ...settings,
      defaultModel: "accounts/fireworks/routers/firerouter",
    }, null, 2)}\n`);
    const models = await readJson(piModelsPath(home));
    models.providers.fireworks.headers = {
      "x-anthropic-api-key": "sk-ant-legacy-byok",
      "x-openai-api-key": "sk-proj-legacy-byok",
      "X-Title": "Pi",
    };
    models.providers.fireworks.models.push({ id: "accounts/fireworks/routers/firerouter", name: "FireRouter" });
    await writeFile(piModelsPath(home), `${JSON.stringify(models, null, 2)}\n`);

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.equal(await refreshPiCatalogForHome(home), true);
    } finally {
      process.env.HOME = prevHome;
    }
    assert.equal((await readJson(piSettingsPath(home))).defaultModel, "auto");
    const after = (await readJson(piModelsPath(home))).providers.fireworks;
    assert.deepEqual(after.headers, {
      "X-Title": "Pi",
      "x-anthropic-api-key": "sk-ant-legacy-byok",
      "x-openai-api-key": "sk-proj-legacy-byok",
    });
    assert.ok(!after.models.some((m) => m.id.includes("firerouter")));
  });

  it("parses Pi files with a UTF-8 BOM", async () => {
    const home = await seedUserPi();
    await writeFile(piModelsPath(home), `\uFEFF${JSON.stringify(USER_MODELS)}\n`);
    const on = await runFireconnect(["pi", "on", "--api-key", KEY], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(on.code, 0, on.stderr);
  });

  it("snapshots and restores a Pi the user already pointed at its own Fireworks provider", async () => {
    const home = await seedUserPi();
    const ownSettings = { ...USER_SETTINGS, defaultProvider: "fireworks", defaultModel: "accounts/fireworks/routers/sample-latest" };
    const ownAuth = { ...USER_AUTH, fireworks: { type: "api_key", key: "FIREWORKS_API_KEY" } };
    await writeFile(piSettingsPath(home), `${JSON.stringify(ownSettings, null, 2)}\n`);
    await writeFile(piAuthPath(home), `${JSON.stringify(ownAuth, null, 2)}\n`);
    const before = await readFile(piSettingsPath(home), "utf8");
    const env = { HOME: home, FIREWORKS_API_KEY: "" };

    await runFireconnect(["pi", "on", "--api-key", KEY, "--model", "auto"], env);
    assert.equal((await readJson(piSettingsPath(home))).defaultModel, "auto");
    await runFireconnect(["pi", "on"], env);
    await runFireconnect(["pi", "off"], env);
    assert.equal(await readFile(piSettingsPath(home), "utf8"), before);
    assert.deepEqual(await readJson(piAuthPath(home)), ownAuth);
  });

  it("reads Pi's JSON with comments and trailing commas, and off restores it verbatim", async () => {
    const home = await seedUserPi();
    const commented = `{\n  // my local models\n  "providers": {\n    "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "ollama", "models": [{ "id": "qwen3:8b" },] },\n  },\n}\n`;
    await writeFile(piModelsPath(home), commented);
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    const on = await runFireconnect(["pi", "on", "--api-key", KEY], env);
    assert.equal(on.code, 0, on.stderr);
    assert.ok((await readJson(piModelsPath(home))).providers.ollama);
    await runFireconnect(["pi", "off"], env);
    assert.equal(await readFile(piModelsPath(home), "utf8"), commented);
  });

  it("uses Nexus's key while on and puts the user's own Fireworks credential back on off", async () => {
    const home = await seedUserPi();
    const ownAuth = { ...USER_AUTH, fireworks: { type: "api_key", key: "FIREWORKS_API_KEY" } };
    await writeFile(piAuthPath(home), `${JSON.stringify(ownAuth, null, 2)}\n`);
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    await runFireconnect(["pi", "on", "--api-key", KEY], env);
    assert.equal((await readJson(piAuthPath(home))).fireworks.key, KEY);

    await runFireconnect(["pi", "off"], env);
    assert.deepEqual(await readJson(piAuthPath(home)), ownAuth);
  });

  it("off deletes the Pi files on created when there was no Pi config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-fw-only-fresh-"));
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    const on = await runFireconnect(["pi", "on", "--api-key", KEY], env);
    assert.equal(on.code, 0, on.stderr);
    assert.equal((await readJson(piSettingsPath(home))).defaultProvider, "fireworks");

    const off = await runFireconnect(["pi", "off"], env);
    assert.equal(off.code, 0, off.stderr);
    for (const filePath of [piSettingsPath(home), piAuthPath(home), piModelsPath(home)]) {
      await assert.rejects(readFile(filePath), { code: "ENOENT" });
    }
  });

  it("re-on drops fireworks rows an early release wrote", async () => {
    const home = await seedUserPi();
    const models = await readJson(piModelsPath(home));
    models.providers.fireworks = {
      compat: { sendSessionAffinityHeaders: true },
      models: [
        { id: "accounts/fireworks/routers/retired-code-fast", name: "Retired" },
        { id: "accounts/fireworks/routers/sample-latest", name: "Sample" },
        { id: "accounts/example-account/deployments/test-deployment", name: "Mine" },
      ],
    };
    await writeFile(piModelsPath(home), `${JSON.stringify(models, null, 2)}\n`);
    await writeFile(piAuthPath(home), `${JSON.stringify({
      ...USER_AUTH,
      fireworks: { type: "api_key", key: KEY, managedBy: "fireconnect" },
    }, null, 2)}\n`);

    const on = await runFireconnect(["pi", "on", "--api-key", KEY], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(on.code, 0, on.stderr);
    const fireworks = (await readJson(piModelsPath(home))).providers.fireworks;
    // Nexus owns providers.fireworks, so the whole entry is rewritten.
    assert.deepEqual(fireworks.models.map((model) => model.id), ["auto"]);
    assert.equal(fireworks.compat, undefined);
  });

  it("keeps an auth.json that existed before on, even when off leaves it empty", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-fw-only-empty-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    await writeFile(piSettingsPath(home), "{}\n");
    await writeFile(piAuthPath(home), "{}\n");
    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    await runFireconnect(["pi", "on", "--api-key", KEY], env);
    await runFireconnect(["pi", "off"], env);

    assert.equal(await readFile(piSettingsPath(home), "utf8"), "{}\n");
    assert.equal(await readFile(piAuthPath(home), "utf8"), "{}\n");
    await assert.rejects(readFile(piModelsPath(home)), { code: "ENOENT" });
  });

  it("upgrade rewrites an enabled Pi's Nexus rows offline; off still restores the old snapshot", async () => {
    const home = await seedUserPi();
    const settingsPath = piSettingsPath(home);
    const modelsPath = piModelsPath(home);
    await mkdir(path.join(home, PI_DATA_RELATIVE_DIR), { recursive: true });
    await writeFile(legacyBackupPath(home, settingsPath, "settings"), JSON.stringify({
      filePath: path.resolve(settingsPath),
      snapshot: { existed: true, raw: await readFile(settingsPath, "utf8") },
    }));
    await writeFile(settingsPath, `${JSON.stringify({
      theme: "dark",
      defaultProvider: "fireworks",
      defaultModel: "accounts/fireworks/routers/sample-latest",
      enabledModels: ["fireworks/accounts/fireworks/routers/*", "fireworks/auto"],
    }, null, 2)}\n`);
    const models = await readJson(modelsPath);
    models.providers.fireworks = {
      compat: { sendSessionAffinityHeaders: true },
      models: [{ id: "auto", name: "Auto" }, { id: "accounts/fireworks/routers/sample-latest", name: "Sample" }],
    };
    await writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`);
    await writeFile(piAuthPath(home), `${JSON.stringify({
      ...USER_AUTH,
      fireworks: { type: "api_key", key: KEY, managedBy: "fireconnect" },
    }, null, 2)}\n`);
    await mkdir(path.join(home, ".nexus"), { recursive: true });
    await writeFile(path.join(home, ".nexus", "config.json"), JSON.stringify({
      harnesses: {
        pi: {
          enabled: true,
          provider: "fireworks",
          profiles: { managedModelIds: ["auto", "accounts/fireworks/routers/sample-latest"] },
        },
      },
    }));

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
      mockServerlessModel({ id: "accounts/fireworks/models/sample-model", aliases: ["accounts/fireworks/routers/sample-latest"] }),
    ]));
    try {
      assert.equal(await refreshPiCatalogForHome(home), true);
    } finally {
      setServerlessCatalogSnapshot(null);
      process.env.HOME = prevHome;
    }

    const settings = await readJson(settingsPath);
    assert.equal(settings.enabledModels, undefined, "the router glob that replaced the user's list is gone");
    const fireworks = (await readJson(modelsPath)).providers.fireworks;
    assert.deepEqual(fireworks.models.map((model) => model.id), ["auto"]);
    assert.equal(fireworks.compat, undefined);

    const off = await runFireconnect(["pi", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(off.code, 0, off.stderr);
    assert.deepEqual(await readJson(settingsPath), USER_SETTINGS);
  });

  it("off restores the snapshots an earlier release took", async () => {
    const home = await seedUserPi();
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);
    const snapshot = async (filePath) => ({
      filePath: path.resolve(filePath),
      snapshot: { existed: true, raw: await readFile(filePath, "utf8") },
    });
    await mkdir(path.join(home, PI_DATA_RELATIVE_DIR), { recursive: true });
    for (const [filePath, label] of [[settingsPath, "settings"], [authPath, "auth"], [modelsPath, "models"]]) {
      await writeFile(legacyBackupPath(home, filePath, label), JSON.stringify(await snapshot(filePath)));
    }
    // What an earlier `on` left behind: the whole scope replaced by Nexus's.
    await writeFile(settingsPath, `${JSON.stringify({
      theme: "dark",
      defaultProvider: "fireworks",
      defaultModel: "auto",
      enabledModels: ["fireworks/accounts/fireworks/routers/*", "fireworks/auto"],
    }, null, 2)}\n`);
    await writeFile(authPath, `${JSON.stringify({
      ...USER_AUTH,
      fireworks: { type: "api_key", key: KEY, managedBy: "fireconnect" },
    }, null, 2)}\n`);

    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    const on = await runFireconnect(["pi", "on", "--api-key", KEY], env);
    assert.equal(on.code, 0, on.stderr);
    await runFireconnect(["pi", "off"], env);
    assert.deepEqual(await readJson(settingsPath), USER_SETTINGS);
    assert.deepEqual(await readJson(authPath), USER_AUTH);
    assert.deepEqual(await readJson(modelsPath), USER_MODELS);
  });
});
