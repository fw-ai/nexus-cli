import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codexCatalogPath, codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { OPENCODE_FIREWORKS_PROVIDER_ID, opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piModelsPath, piSettingsPath } from "../../lib/harnesses/pi/core.mjs";
import { USER_SETTINGS_RELATIVE_PATH } from "../../lib/harnesses/claude/core.mjs";
import { deletePersistedCatalogCache } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { runFireconnect, withTempHome } from "../helpers.mjs";

const V1_KEY = "fw_cataloged_v1_adversarial000000";
const V2_KEY = "fw_cataloged_v2_adversarial000000";
const NO_ENV = { FIREWORKS_API_KEY: "" };
const SELECTED = "kimi-latest";
const DELISTED_SELECTED = "deepseek-v4-flash";

function clearCatalogCacheForHome(home) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    deletePersistedCatalogCache();
  } finally {
    process.env.HOME = prevHome;
  }
}

async function runOnSequence(home, harness, { model = "", apiKey = V1_KEY } = {}) {
  const base = [harness, "on", "--api-key", apiKey];
  const withModel = model ? [...base, "--model", model] : base;
  const steps = [
    await runFireconnect(base, { HOME: home, ...NO_ENV }),
    await runFireconnect(withModel, { HOME: home, ...NO_ENV }),
    await runFireconnect(withModel, { HOME: home, ...NO_ENV }),
  ];
  for (const step of steps) {
    assert.equal(step.code, 0, step.stderr);
  }
  return steps;
}

describe("catalog rerun adversarial scenarios", () => {
  it("codex plain on prunes missing rows and adds newly served ones", async () => {
    await withTempHome("adv-codex-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await runOnSequence(home, "codex", { model: SELECTED });

      const catalogPath = codexCatalogPath(home);
      const beforeV2 = JSON.parse(await readFile(catalogPath, "utf8"));
      beforeV2.models.push({
        slug: "retired-user-model",
        display_name: "Retired",
        context_window: 1000,
        max_context_window: 1000,
      });
      await writeFile(catalogPath, `${JSON.stringify(beforeV2, null, 2)}\n`);

      clearCatalogCacheForHome(home);
      const v2 = await runFireconnect(
        ["codex", "on", "--api-key", V2_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(v2.code, 0, v2.stderr);

      const slugs = JSON.parse(await readFile(catalogPath, "utf8")).models.map((row) => row.slug);
      assert.ok(slugs.includes("glm-latest"), "new v2 model is added");
      assert.ok(slugs.includes("kimi-latest"), "v2 catalog keeps kimi-latest");
      assert.ok(!slugs.includes("retired-user-model"), "user row missing from serverless is dropped");
      assert.ok(!slugs.includes("deepseek-v4-flash"), "delisted model removed when not selected");
      assert.equal(slugs.length, new Set(slugs).size, "no duplicate rows");
    });
  });

  it("codex plain on drops a FireRouter route to auto and still refreshes the catalog", async () => {
    for (const route of ["", "firerouter/opus"]) {
      await withTempHome("adv-codex-firerouter-refresh-", async (home) => {
        await mkdir(path.join(home, ".codex"), { recursive: true });
        const first = await runFireconnect(
          ["codex", "on", "--api-key", V1_KEY],
          { HOME: home, ...NO_ENV },
        );
        assert.equal(first.code, 0, first.stderr);
        if (route) {
          // What an earlier release wrote for `--model firerouter/opus`.
          await writeFile(
            codexConfigPath(home),
            (await readFile(codexConfigPath(home), "utf8"))
              .replace(/^model = .*$/m, `model = "${route}"`),
          );
          const seeded = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
          seeded.models.push({ slug: route, display_name: "FireRouter · Opus" });
          await writeFile(codexCatalogPath(home), JSON.stringify(seeded));
        }
        const catalogPath = codexCatalogPath(home);
        const before = JSON.parse(await readFile(catalogPath, "utf8"));
        before.models.push({ slug: "retired-user-model", display_name: "Retired", context_window: 1000, max_context_window: 1000 });
        await writeFile(catalogPath, `${JSON.stringify(before, null, 2)}\n`);

        clearCatalogCacheForHome(home);
        const rerun = await runFireconnect(["codex", "on", "--api-key", V2_KEY], { HOME: home, ...NO_ENV });
        assert.equal(rerun.code, 0, rerun.stderr);

        // The plain re-run drops any stored FireRouter usage to `auto`.
        assert.match(await readFile(codexConfigPath(home), "utf8"), /^model = "auto"$/m);
        const slugs = JSON.parse(await readFile(catalogPath, "utf8")).models.map((row) => row.slug);
        assert.ok(slugs.includes("auto"), `auto: ${slugs.join(",")}`);
        assert.ok(!slugs.some((slug) => slug.startsWith("firerouter")), `no firerouter row: ${slugs.join(",")}`);
        assert.ok(slugs.includes("glm-latest"), "new v2 model is added");
        assert.ok(!slugs.includes("retired-user-model"), "row missing from serverless is dropped");
        assert.equal(slugs.length, new Set(slugs).size, "no duplicate rows");
      });
    }
  });

  it("codex drops a FireRouter path to auto on re-on without --model, keeping the catalog ref", async () => {
    await withTempHome("adv-codex-firerouter-path-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      const plain = await runFireconnect(
        ["codex", "on", "--api-key", V1_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(plain.code, 0, plain.stderr);
      // What an earlier release wrote for `--model firerouter/test-model`.
      await writeFile(
        codexConfigPath(home),
        (await readFile(codexConfigPath(home), "utf8"))
          .replace(/^model = .*$/m, 'model = "firerouter/test-model"'),
      );
      const seeded = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
      seeded.models.push({ slug: "firerouter/test-model", display_name: "FireRouter · Test" });
      await writeFile(codexCatalogPath(home), JSON.stringify(seeded));
      const rerun = await runFireconnect(
        ["codex", "on", "--api-key", V1_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(rerun.code, 0, rerun.stderr);

      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /model = "auto"/);
      assert.match(config, /model_catalog_json/);
      const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
      assert.ok(slugs.includes("auto"));
      assert.ok(!slugs.includes("firerouter/test-model"));
    });
  });

  it("codex drops a delisted catalog row even when its model stays selected", async () => {
    await withTempHome("adv-codex-selected-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      const first = await runFireconnect(
        ["codex", "on", "--api-key", V1_KEY, "--model", DELISTED_SELECTED],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(first.code, 0, first.stderr);

      clearCatalogCacheForHome(home);
      // Preserve the configured model while refreshing its catalog row.
      const v2 = await runFireconnect(
        ["codex", "on", "--api-key", V2_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(v2.code, 0, v2.stderr);

      const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
      assert.ok(!slugs.includes(DELISTED_SELECTED), "delisted model removed from catalog");
      assert.ok(slugs.includes("glm-latest"), "new v2 model is added");
      assert.match(await readFile(codexConfigPath(home), "utf8"), /model = "deepseek-v4-flash"/);
    });
  });

  it("opencode plain on prunes missing rows and adds newly served ones", async () => {
    await withTempHome("adv-opencode-", async (home) => {
      await mkdir(path.join(home, ".config/opencode"), { recursive: true });
      await runOnSequence(home, "opencode", { model: SELECTED });

      const configPath = opencodeConfigPath(home);
      const stale = JSON.parse(await readFile(configPath, "utf8"));
      stale.provider[OPENCODE_FIREWORKS_PROVIDER_ID].models["retired-user-model"] = {
        name: "Retired",
        limit: { context: 1000, output: 1000 },
      };
      await writeFile(configPath, `${JSON.stringify(stale, null, 2)}\n`);

      clearCatalogCacheForHome(home);
      const v2 = await runFireconnect(
        ["opencode", "on", "--api-key", V2_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(v2.code, 0, v2.stderr);

      const models = JSON.parse(await readFile(configPath, "utf8"))
        .provider[OPENCODE_FIREWORKS_PROVIDER_ID].models;
      const keys = Object.keys(models);
      assert.ok(keys.includes("glm-latest"), "new v2 model is added");
      assert.ok(keys.includes("kimi-latest"), "v2 catalog keeps kimi-latest");
      assert.equal(models["retired-user-model"], undefined, "stale provider row dropped");
      assert.equal(models["deepseek-v4-flash"], undefined, "delisted catalog model not re-registered");
      assert.equal(models["accounts/fireworks/models/deepseek-v4-flash"], undefined, "no duplicate full-id key");
    });
  });

  it("claude plain on prunes delisted picker rows, adds new ones, and keeps claude-* rows", async () => {
    await withTempHome("adv-claude-", async (home) => {
      await mkdir(path.join(home, ".claude"), { recursive: true });
      await runOnSequence(home, "claude", { model: SELECTED });

      const settingsPath = path.join(home, USER_SETTINGS_RELATIVE_PATH);
      const stale = JSON.parse(await readFile(settingsPath, "utf8"));
      stale.modelPicker.options.push(
        { model: "retired-user-model[1m]", label: "Retired", description: "stale" },
        { model: "claude-sonnet-4-6", label: "Mine", description: "user row" },
      );
      const kimiRow = stale.modelPicker.options.find((row) => row.model.startsWith("kimi-latest"));
      kimiRow.label = "OLD LABEL";
      await writeFile(settingsPath, `${JSON.stringify(stale, null, 2)}\n`);

      clearCatalogCacheForHome(home);
      const v2 = await runFireconnect(
        ["claude", "on", "--api-key", V2_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(v2.code, 0, v2.stderr);

      const options = JSON.parse(await readFile(settingsPath, "utf8")).modelPicker.options;
      const ids = options.map((row) => row.model);
      assert.ok(ids.some((id) => id.startsWith("glm-latest")), "new v2 model is added");
      assert.ok(ids.some((id) => id.startsWith("kimi-latest")), "v2 catalog keeps kimi-latest");
      assert.ok(!ids.some((id) => id.includes("retired-user-model")), "stale row pruned");
      assert.ok(!ids.some((id) => id.includes("deepseek-v4-flash")), "delisted catalog row pruned");
      assert.deepEqual(
        options.find((row) => row.model === "claude-sonnet-4-6"),
        { model: "claude-sonnet-4-6", label: "Mine", description: "user row" },
        "claude-* row kept verbatim",
      );
      assert.notEqual(
        options.find((row) => row.model.startsWith("kimi-latest")).label,
        "OLD LABEL",
        "kept catalog row re-rendered",
      );
      assert.equal(ids.length, new Set(ids).size, "no duplicate rows");
    });
  });

  it("pi plain on keeps only Nexus-only rows; the selected model stays the default", async () => {
    await withTempHome("adv-pi-", async (home) => {
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await runOnSequence(home, "pi", { model: SELECTED });

      const modelsPath = piModelsPath(home);
      clearCatalogCacheForHome(home);
      const v2 = await runFireconnect(
        ["pi", "on", "--api-key", V2_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(v2.code, 0, v2.stderr);

      const fireworks = JSON.parse(await readFile(modelsPath, "utf8")).providers.fireworks;
      const ids = fireworks.models.map((row) => row.id);
      assert.ok(!ids.some((id) => id.endsWith("/glm-latest")), "catalog routers are Pi's");
      assert.ok(!ids.some((id) => id.endsWith("/kimi-latest")), "catalog routers are Pi's");
      assert.ok(ids.includes("auto"));
      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultModel, `accounts/fireworks/routers/${SELECTED}`);
    });
  });
});
