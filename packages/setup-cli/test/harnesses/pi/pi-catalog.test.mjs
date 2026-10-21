import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { piKnownFireworksModelIds } from "../../../lib/harnesses/pi/pi-catalog.mjs";

const SAMPLE = "accounts/fireworks/routers/sample-latest";
const OVERLAY_ONLY = "accounts/fireworks/models/sample-new";

/** A global-npm-style Pi install: bin/pi -> pi-coding-agent, pi-ai nested or hoisted. */
async function fakePi({ scope, layout, catalog }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fc-pi-catalog-"));
  const modules = path.join(root, "lib/node_modules");
  const agent = path.join(modules, scope, "pi-coding-agent");
  await mkdir(path.join(agent, "dist"), { recursive: true });
  await writeFile(path.join(agent, "package.json"), JSON.stringify({ name: `${scope}/pi-coding-agent` }));
  await writeFile(path.join(agent, "dist/cli.js"), "");
  const piAi = layout === "nested"
    ? path.join(agent, "node_modules", scope, "pi-ai", "dist")
    : path.join(modules, scope, "pi-ai", "dist");
  await mkdir(path.join(piAi, "providers/data"), { recursive: true });
  if (catalog === "json") {
    await writeFile(
      path.join(piAi, "providers/data/fireworks.json"),
      JSON.stringify({ "openai-completions": { [`chat:${SAMPLE}`]: { id: SAMPLE } } }),
    );
  } else {
    await writeFile(path.join(piAi, "models.generated.js"), `export const M = { id: "${SAMPLE}" };\n`);
  }
  await mkdir(path.join(root, "bin"));
  await symlink(path.join(agent, "dist/cli.js"), path.join(root, "bin/pi"));
  const agentDir = path.join(root, "home/.pi/agent");
  await mkdir(agentDir, { recursive: true });
  return { env: { PATH: path.join(root, "bin") }, settingsPath: path.join(agentDir, "settings.json") };
}

describe("piKnownFireworksModelIds", { skip: process.platform === "win32" }, () => {
  it("reads the bundled catalog and the cached pi.dev overlay of a current Pi", async () => {
    const { env, settingsPath } = await fakePi({ scope: "@earendil-works", layout: "hoisted", catalog: "json" });
    await writeFile(
      path.join(path.dirname(settingsPath), "models-store.json"),
      JSON.stringify({ fireworks: { models: [{ id: OVERLAY_ONLY }] } }),
    );
    const known = piKnownFireworksModelIds({ settingsPath, env });
    assert.ok(known.has(SAMPLE));
    assert.ok(known.has(OVERLAY_ONLY));
  });

  it("reads an older Pi's generated catalog", async () => {
    const { env, settingsPath } = await fakePi({ scope: "@mariozechner", layout: "nested", catalog: "js" });
    assert.deepEqual([...piKnownFireworksModelIds({ settingsPath, env })], [SAMPLE]);
  });

  it("returns null without a readable Pi, and in tests", async () => {
    assert.equal(piKnownFireworksModelIds({ settingsPath: "/x/settings.json", env: { PATH: os.tmpdir() } }), null);
    const { env, settingsPath } = await fakePi({ scope: "@earendil-works", layout: "nested", catalog: "json" });
    assert.equal(piKnownFireworksModelIds({ settingsPath, env: { ...env, NEXUS_TEST: "1" } }), null);
  });
});
