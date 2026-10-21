import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { codexCatalogPath } from "../../../lib/harnesses/codex/core.mjs";
import { migrateCodexCatalogConstantsOnUpgrade } from "../../../lib/harnesses/codex/upgrade-migrations.mjs";
import { runFireconnect, withTempHome } from "../../helpers.mjs";

const API_KEY = "fw_cataloged_v1_adversarial000000";

async function readCatalog(home) {
  return JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
}

/** Rewrite every row the way a release with tool search off everywhere wrote it. */
async function writeAllSearchOff(home) {
  const catalog = await readCatalog(home);
  const models = catalog.models.map((row) => ({ ...row, supports_search_tool: false }));
  await writeFile(codexCatalogPath(home), `${JSON.stringify({ ...catalog, models }, null, 2)}\n`);
}

describe("migrateCodexCatalogConstantsOnUpgrade", () => {
  it("turns tool search on for every row, Claude routes included", async () => {
    await withTempHome("codex-search-migrate", async (home) => {
      const on = await runFireconnect(
        ["codex", "on", "--api-key", API_KEY],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(on.code, 0, on.stderr);
      // Rows an earlier release registered for FireRouter selections.
      const seeded = await readCatalog(home);
      seeded.models.push(
        { slug: "firerouter/test-model", display_name: "FireRouter · Test" },
        { slug: "firerouter/opus", display_name: "FireRouter · Opus" },
      );
      await writeFile(codexCatalogPath(home), `${JSON.stringify(seeded, null, 2)}\n`);
      await writeAllSearchOff(home);

      assert.equal(await migrateCodexCatalogConstantsOnUpgrade(home), true);

      const bySlug = new Map((await readCatalog(home)).models.map((row) => [row.slug, row]));
      assert.equal(bySlug.get("kimi-latest")?.supports_search_tool, true);
      assert.equal(bySlug.get("firerouter/test-model")?.supports_search_tool, true);
      assert.equal(bySlug.get("auto")?.supports_search_tool, true);
      assert.equal(bySlug.get("firerouter/opus")?.supports_search_tool, true);
      const gptRows = [...bySlug.values()].filter((row) => row.slug.startsWith("gpt-"));
      assert.ok(gptRows.length > 0, "codex on writes the GPT sign-in rows");
      assert.ok(gptRows.every((row) => row.supports_search_tool === true), "GPT rows follow stock Codex");

      const settled = await readFile(codexCatalogPath(home), "utf8");
      assert.equal(await migrateCodexCatalogConstantsOnUpgrade(home), false);
      assert.equal(await readFile(codexCatalogPath(home), "utf8"), settled);
    });
  });

  it("does not recreate the catalog once codex is off", async () => {
    await withTempHome("codex-search-migrate-off", async (home) => {
      for (const args of [["codex", "on", "--api-key", API_KEY], ["codex", "off"]]) {
        const result = await runFireconnect(args, { HOME: home, FIREWORKS_API_KEY: "" });
        assert.equal(result.code, 0, result.stderr);
      }

      assert.equal(await migrateCodexCatalogConstantsOnUpgrade(home), false);
      await assert.rejects(readFile(codexCatalogPath(home), "utf8"), { code: "ENOENT" });
    });
  });
});
