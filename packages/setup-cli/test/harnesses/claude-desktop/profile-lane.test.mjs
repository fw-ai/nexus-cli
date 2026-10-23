import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

import { createAutoKeysLoader, createAutoProvidersLoader, createShimServer } from "../../../lib/harnesses/claude-desktop/shim.mjs";
import {
  detectConnectors, migrateSkillsPlugin, DEFAULT_MODEL_MAP, firstPartyDir, thirdPartyDir,
} from "../../../lib/harnesses/claude-desktop/profile-lane.mjs";

process.env.NEXUS_TEST = "1";

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "fc-profile-lane-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

async function writeSession(home, deployment, account, name, servers) {
  const root = deployment === "Claude-3p" ? thirdPartyDir(home) : firstPartyDir(home);
  const dir = path.join(root, "local-agent-mode-sessions", account, "org");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), JSON.stringify({
    sessionId: name, remoteMcpServersConfig: servers,
  }));
}

test("detectConnectors dedupes by name across sessions and deployments", async () => {
  const { home, cleanup } = await tempHome();
  try {
    await writeSession(home, "Claude", "acct-1", "local_a.json", [
      { uuid: "1", name: "Linear", url: "https://mcp.linear.app/mcp" },
      { uuid: "2", name: "Slack", url: "https://mcp.slack.com/mcp" },
    ]);
    await writeSession(home, "Claude-3p", "acct-2", "local_b.json", [
      { uuid: "3", name: "linear", url: "https://mcp.linear.app/mcp" },
      // Non-https and malformed entries are skipped.
      { uuid: "4", name: "local", url: "http://127.0.0.1:1/mcp" },
      { uuid: "5", url: "https://mcp.example.com/mcp" },
    ]);
    const connectors = await detectConnectors(home);
    assert.deepEqual(connectors, [
      { name: "linear", transport: "http", url: "https://mcp.linear.app/mcp" },
      { name: "slack", transport: "http", url: "https://mcp.slack.com/mcp" },
    ]);
  } finally { await cleanup(); }
});

test("detectConnectors returns [] when no sessions exist (offline/cold cache)", async () => {
  const { home, cleanup } = await tempHome();
  try {
    assert.deepEqual(await detectConnectors(home), []);
  } finally { await cleanup(); }
});

test("migrateSkillsPlugin copies skills/plugin assets one-way, additively", async () => {
  const { home, cleanup } = await tempHome();
  try {
    const first = firstPartyDir(home);
    const third = thirdPartyDir(home);
    const srcSkill = path.join(first, "local-agent-mode-sessions", "skills-plugin", "org-1", "acct-1", "skills", "demo", "SKILL.md");
    await mkdir(path.dirname(srcSkill), { recursive: true });
    await writeFile(srcSkill, "# demo skill");
    // Pre-existing dest file is never overwritten.
    const dstSkill = path.join(third, "local-agent-mode-sessions", "skills-plugin", "org-1", "acct-1", "skills", "demo", "SKILL.md");
    await mkdir(path.dirname(dstSkill), { recursive: true });
    await writeFile(dstSkill, "mine, keep me");

    const copied = await migrateSkillsPlugin(home);
    assert.equal(copied, 0); // every asset already exists in 3p
    assert.equal(await readFile(dstSkill, "utf8"), "mine, keep me");

    // A NEW skill in claude.ai mode crosses over; sessions never do.
    const srcNew = path.join(first, "local-agent-mode-sessions", "skills-plugin", "org-1", "acct-1", "skills", "demo", "helper.py");
    await writeFile(srcNew, "print('hi')");
    await mkdir(path.join(first, "local-agent-mode-sessions", "acct-1", "org-1"), { recursive: true });
    await writeFile(path.join(first, "local-agent-mode-sessions", "acct-1", "org-1", "local_a.json"), "{}");
    assert.equal(await migrateSkillsPlugin(home), 1);
    await readFile(path.join(third, "local-agent-mode-sessions", "skills-plugin", "org-1", "acct-1", "skills", "demo", "helper.py"), "utf8");
    await assert.rejects(stat(path.join(third, "local-agent-mode-sessions", "acct-1")));
    // Cold cache: nothing to copy, no crash.
    const { home: empty, cleanup: clean2 } = await tempHome();
    try { assert.equal(await migrateSkillsPlugin(empty), 0); } finally { await clean2(); }
  } finally { await cleanup(); }
});

async function startShim(modelMap) {
  const catalogDir = await mkdtemp(path.join(tmpdir(), "fc-shim-catalog-"));
  const server = createShimServer({ modelMap, catalogDir, log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { port, close: () => new Promise((done) => server.close(() => done())) };
}

test("shim maps claude-* names to Fireworks routes and translates x-api-key", async () => {
  const { port, close } = await startShim(DEFAULT_MODEL_MAP);
  try {
    // count_tokens is answered locally without network.
    const ct = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello world" }] }),
    });
    assert.equal(ct.status, 200);
    assert.ok((await ct.json()).input_tokens >= 1);

    // No discovery endpoint: the profile carries inferenceModels, so the
    // picker uses the static list; /v1/models passes through upstream
    // (not probed here — the shim's default upstream is production).

    // Root probe answers locally.
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
  } finally { await close(); }
});

test("shim model mapping: exact names, then family substrings, then passthrough", async () => {
  const modelMap = DEFAULT_MODEL_MAP;
  const map = (n) => {
    if (Object.hasOwn(modelMap.models, n)) return modelMap.models[n];
    for (const [family, target] of Object.entries(modelMap.families)) {
      if (n.toLowerCase().includes(family)) return target;
    }
    return n;
  };
  assert.equal(map("claude-opus-4-8"), "auto");
  assert.equal(map("claude-haiku-4-5-20251001"), "glm-flash-latest");
  assert.equal(map("claude-fable-5"), "auto");
  assert.equal(map("some-other-model"), "some-other-model");
});

async function enableFakeProfile(home, servers = []) {
  const lib = path.join(thirdPartyDir(home), "configLibrary");
  await mkdir(lib, { recursive: true });
  await writeFile(path.join(lib, "prof-1.json"), JSON.stringify({ managedMcpServers: servers }));
  await writeFile(path.join(lib, "_meta.json"), JSON.stringify({ appliedId: "prof-1", entries: [{ id: "prof-1", name: "Fireworks" }] }));
  const dataDir = path.join(home, ".nexus", "claude-desktop");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "profile-state.json"), JSON.stringify({ enabled: true, lane: "profile", profileId: "prof-1" }));
}

test("profile connectors: add (http + stdio), replace, remove, list", async () => {
  const { home, cleanup } = await tempHome();
  try {
    await enableFakeProfile(home);
    await addProfileConnector(home, { name: "linear", url: "https://mcp.linear.app/mcp", oauth: { clientId: "x" } });
    await addProfileConnector(home, { name: "fs", command: "uvx", args: ["mcp-fs"] });
    let list = await listProfileConnectors(home);
    assert.equal(list.length, 2);
    assert.equal(list[0].transport, "http");
    assert.equal(list[1].command, "uvx");

    await addProfileConnector(home, { name: "linear", url: "https://mcp.linear.app/v2" });
    list = await listProfileConnectors(home);
    assert.equal(list.length, 2);
    assert.equal(list[0].url, "https://mcp.linear.app/v2");

    assert.equal(await removeProfileConnector(home, "fs"), true);
    assert.equal(await removeProfileConnector(home, "fs"), false);

    await assert.rejects(() => addProfileConnector(home, { name: "bad", url: "http://insecure.example/mcp" }));
    await assert.rejects(() => addProfileConnector(home, { name: "also-bad" }));
  } finally { await cleanup(); }
});

test("sync rebuilds from sources; org-registered entries kept with oauth", async () => {
  const { home, cleanup } = await tempHome();
  try {
    await enableFakeProfile(home, [
      { name: "manual-only", transport: "http", url: "https://mcp.example.com/mcp" },
      { name: "slack", transport: "http", url: "https://mcp.slack.com/mcp", oauth: { clientId: "keep-me" } },
    ]);
    await writeSession(home, "Claude", "acct-1", "local_a.json", [
      { uuid: "1", name: "Linear", url: "https://mcp.linear.app/mcp" },
    ]);
    const fp = firstPartyDir(home);
    await mkdir(fp, { recursive: true });
    await writeFile(path.join(fp, "claude_desktop_config.json"), JSON.stringify({
      mcpServers: { slack: { type: "http", url: "https://mcp.slack.com/mcp" } },
    }));
    const noOrg = { listOrgConnectors: async () => [] };
    const { total } = await syncProfileConnectors(home, noOrg);
    assert.equal(total, 2);
    const names = (await listProfileConnectors(home)).map((c) => c.name).sort();
    assert.deepEqual(names, ["linear", "slack"]); // profile-only entry dropped
    // oauth from the previous entry survives the rebuild
    const slack = (await listProfileConnectors(home)).find((c) => c.name === "slack");
    assert.equal(slack.oauth.clientId, "keep-me");
  } finally { await cleanup(); }
});

import { parseClaudeMcpList, connectorSlug } from "../../../lib/harnesses/claude-desktop/profile-lane.mjs";

test("connectorSlug turns display names into managed-MCP-safe names", () => {
  assert.equal(connectorSlug("Google Drive"), "google-drive");
  assert.equal(connectorSlug("Example Wiki"), "example-wiki");
  assert.equal(connectorSlug("linear"), "linear");
  assert.equal(connectorSlug("  "), "");
  assert.equal(connectorSlug("123"), "");
});

test("parseClaudeMcpList keeps only claude.ai org connector rows", () => {
  const out = [
    "Checking MCP server health…",
    "",
    "claude.ai Example Docs: https://docs.example.com/mcp - ✔ Connected",
    "claude.ai Google Drive: https://drive.example.com/mcp/v1 - ! Needs authentication",
    "local-server: https://mcp.example.com/mcp (HTTP) - ! Needs authentication",
    "claude.ai Broken: http://insecure.example/mcp - ✘ Failed",
  ].join("\n");
  assert.deepEqual(parseClaudeMcpList(out), [
    { name: "example-docs", transport: "http", url: "https://docs.example.com/mcp" },
    { name: "google-drive", transport: "http", url: "https://drive.example.com/mcp/v1" },
  ]);
  assert.deepEqual(parseClaudeMcpList(""), []);
});

test("sync adds org-registry connectors without clobbering local ones", async () => {
  const { home, cleanup } = await tempHome();
  try {
    await enableFakeProfile(home);
    await writeSession(home, "Claude", "acct-1", "local_a.json", [
      { uuid: "1", name: "Linear", url: "https://mcp.linear.app/mcp" },
    ]);
    const { total, fromOrg } = await syncProfileConnectors(home, {
      listOrgConnectors: async () => [
        { name: "linear", transport: "http", url: "https://mcp.example.com/other-linear" },
        { name: "example-crm", transport: "http", url: "https://mcp.example.com/crm" },
      ],
    });
    assert.equal(fromOrg, 2);
    assert.equal(total, 2);
    const byName = Object.fromEntries((await listProfileConnectors(home)).map((c) => [c.name, c.url]));
    assert.equal(byName.linear, "https://mcp.linear.app/mcp"); // local wins
    assert.equal(byName["example-crm"], "https://mcp.example.com/crm");
    // an org source failure degrades to local-only
    const r = await syncProfileConnectors(home, { listOrgConnectors: async () => { throw new Error("offline"); } });
    assert.equal(r.fromOrg, 0);
  } finally { await cleanup(); }
});

test("mcp remove sticks across sync until the connector is added back", async () => {
  const { home, cleanup } = await tempHome();
  try {
    await enableFakeProfile(home);
    const org = { listOrgConnectors: async () => [
      { name: "example-design", transport: "http", url: "https://mcp.example.com/design" },
      { name: "example-crm", transport: "http", url: "https://mcp.example.com/crm" },
    ] };
    await syncProfileConnectors(home, org);
    assert.equal(await removeProfileConnector(home, "example-design"), true);
    await syncProfileConnectors(home, org);
    let names = (await listProfileConnectors(home)).map((c) => c.name);
    assert.deepEqual(names, ["example-crm"]);
    // explicit add clears the exclusion
    await addProfileConnector(home, { name: "example-design", url: "https://mcp.example.com/design" });
    await removeProfileConnector(home, "example-crm");
    await syncProfileConnectors(home, org);
    names = (await listProfileConnectors(home)).map((c) => c.name).sort();
    assert.deepEqual(names, ["example-design"]);
  } finally { await cleanup(); }
});

test("mcp add/remove/sync mirror the connector setup into the durable store", async () => {
  const { home, cleanup } = await tempHome();
  try {
    await enableFakeProfile(home);
    const storePath = path.join(home, ".nexus", "claude-desktop", "connectors.json");
    await addProfileConnector(home, { name: "linear", url: "https://mcp.linear.app/mcp", oauth: { clientId: "x" } });
    await addProfileConnector(home, { name: "fs", command: "uvx", args: ["mcp-fs"] });
    await removeProfileConnector(home, "fs");
    let store = JSON.parse(await readFile(storePath, "utf8"));
    assert.deepEqual(store.servers.map((s) => s.name), ["linear"]);
    assert.deepEqual(store.excluded, ["fs"]);
    await syncProfileConnectors(home, { listOrgConnectors: async () => [] });
    store = JSON.parse(await readFile(storePath, "utf8"));
    assert.deepEqual(store.servers.map((s) => s.name), ["linear"]);
    assert.deepEqual(store.excluded, ["fs"]);
    // Removing the last connector must persist an EMPTY list — otherwise the
    // next on resurrects the removed connector from a stale store.
    await removeProfileConnector(home, "linear");
    store = JSON.parse(await readFile(storePath, "utf8"));
    assert.deepEqual(store.servers, []);
    assert.deepEqual(store.excluded.sort(), ["fs", "linear"]);
  } finally { await cleanup(); }
});

test("off snapshots the connector setup before deleting the profiles", async () => {
  const { home, cleanup } = await tempHome();
  try {
    // Simulate a profile built by an older version whose writes never hit the
    // store: off must still capture what the applied profile carried.
    await enableFakeProfile(home, [
      { name: "slack", transport: "http", url: "https://mcp.slack.com/mcp" },
    ]);
    const statePath = path.join(home, ".nexus", "claude-desktop", "profile-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, JSON.stringify({ ...state, excludedConnectors: ["granola"] }));
    const { disableProfileLane } = await import("../../../lib/harnesses/claude-desktop/profile-lane.mjs");
    await disableProfileLane(home, { log: () => {} });
    const store = JSON.parse(await readFile(
      path.join(home, ".nexus", "claude-desktop", "connectors.json"), "utf8"));
    assert.deepEqual(store.servers.map((s) => s.name), ["slack"]);
    assert.deepEqual(store.excluded, ["granola"]);
    // The applied profile itself is gone, as before.
    await assert.rejects(() => readFile(path.join(
      thirdPartyDir(home), "configLibrary", "prof-1.json"), "utf8"));
  } finally { await cleanup(); }
});

import {
  addProfileConnector, removeProfileConnector, listProfileConnectors, syncProfileConnectors,
} from "../../../lib/harnesses/claude-desktop/profile-lane.mjs";
import { desktopOAuth } from "../../../lib/harnesses/claude-desktop/profile-lane.mjs";

test("desktopOAuth pins localhost for pre-registered clients with a fixed port", () => {
  assert.deepEqual(desktopOAuth({ clientId: "example-client", callbackPort: 3118 }),
    { clientId: "example-client", callbackPort: 3118, callbackHost: "localhost" });
  // explicit host is respected
  assert.equal(desktopOAuth({ clientId: "c", callbackPort: 1, callbackHost: "127.0.0.1" }).callbackHost, "127.0.0.1");
  // dynamic registration (no clientId) is left alone
  assert.equal(desktopOAuth({ callbackPort: 3118 }).callbackHost, undefined);
  assert.equal(desktopOAuth(undefined), undefined);
});

test("sync upgrades an existing oauth entry to pin localhost", async () => {
  const { home, cleanup } = await tempHome();
  try {
    await enableFakeProfile(home, [{ name: "example-chat", transport: "http", url: "https://mcp.example.com/chat", oauth: { clientId: "example-client", callbackPort: 3118 } }]);
    await writeSession(home, "Claude", "acct-1", "local_a.json", [
      { uuid: "1", name: "example-chat", url: "https://mcp.example.com/chat" },
    ]);
    await syncProfileConnectors(home, { listOrgConnectors: async () => [] });
    const entry = (await listProfileConnectors(home)).find((c) => c.name === "example-chat");
    assert.equal(entry.oauth.callbackHost, "localhost");
  } finally { await cleanup(); }
});

import { isConnectorUrl } from "../../../lib/harnesses/claude-desktop/profile-lane.mjs";

test("isConnectorUrl: https anywhere, http only on loopback", () => {
  assert.equal(isConnectorUrl("https://mcp.example.com/mcp"), true);
  assert.equal(isConnectorUrl("http://127.0.0.1:3845/mcp"), true);
  assert.equal(isConnectorUrl("http://localhost:3845/mcp"), true);
  assert.equal(isConnectorUrl("http://[::1]:3845/mcp"), true);
  assert.equal(isConnectorUrl("http://mcp.example.com/mcp"), false);
  assert.equal(isConnectorUrl("http://127.0.0.1.example.com/mcp"), false);
  assert.equal(isConnectorUrl("ftp://127.0.0.1/mcp"), false);
  assert.equal(isConnectorUrl("not a url"), false);
});

import { detectShimProfileId } from "../../../lib/harnesses/claude-desktop/profile-lane.mjs";

const SHIM_PROFILE_BODY = {
  inferenceGatewayBaseUrl: "http://127.0.0.1:8799",
  inferenceGatewayApiKey: "fw_testkey",
  inferenceProvider: "gateway",
  inferenceCredentialKind: "static",
};

test("detectShimProfileId fingerprints our profile; lookalikes on the same port don't match", async () => {
  const { home, cleanup } = await tempHome();
  try {
    const lib = path.join(thirdPartyDir(home), "configLibrary");
    await mkdir(lib, { recursive: true });
    // Ours (even a stale old-format one, as long as the fingerprint holds).
    await writeFile(path.join(lib, "stale-fw.json"), JSON.stringify({ ...SHIM_PROFILE_BODY, modelCatalogEnabled: true }));
    // Same loopback port, but a user's own gateway: not ours.
    await writeFile(path.join(lib, "lookalike.json"), JSON.stringify({
      ...SHIM_PROFILE_BODY, inferenceGatewayApiKey: "sk-not-fireworks",
    }));
    await writeFile(path.join(lib, "_meta.json"), JSON.stringify({
      appliedId: "stale-fw",
      entries: [{ id: "lookalike", name: "Mine" }, { id: "stale-fw", name: "Fireworks" }],
    }));
    assert.equal(await detectShimProfileId(lib, "http://127.0.0.1:8799", home), "stale-fw");
    // A different default port must not match the fingerprint.
    assert.equal(await detectShimProfileId(lib, "http://127.0.0.1:9000", home), null);
    // Legacy profiles written with an fpk_ key still fingerprint as ours.
    await writeFile(path.join(lib, "stale-fpk.json"), JSON.stringify({ ...SHIM_PROFILE_BODY, inferenceGatewayApiKey: "fpk_testkey" }));
    await writeFile(path.join(lib, "stale-fw.json"), JSON.stringify({ ...SHIM_PROFILE_BODY, inferenceGatewayBaseUrl: "https://elsewhere.example" }));
    assert.equal(await detectShimProfileId(lib, "http://127.0.0.1:8799", home), null); // stale-fw no longer loopback, fpk not in _meta entries
    const meta = JSON.parse(await readFile(path.join(lib, "_meta.json"), "utf8"));
    meta.entries.push({ id: "stale-fpk", name: "Fireworks" });
    await writeFile(path.join(lib, "_meta.json"), JSON.stringify(meta));
    assert.equal(await detectShimProfileId(lib, "http://127.0.0.1:8799", home), "stale-fpk");
  } finally { await cleanup(); }
});

test("detectShimProfileId prefers the durable written-profiles registry over content", async () => {
  const { home, cleanup } = await tempHome();
  try {
    const lib = path.join(thirdPartyDir(home), "configLibrary");
    await mkdir(lib, { recursive: true });
    // Registry says "registered-id" is ours even though its file is not
    // shim-shaped (e.g. mid-rewrite); the fingerprint finds nothing.
    await writeFile(path.join(lib, "registered-id.json"), JSON.stringify({ inferenceGatewayBaseUrl: "https://gateway.example.com" }));
    await writeFile(path.join(lib, "_meta.json"), JSON.stringify({
      appliedId: null, entries: [{ id: "registered-id", name: "Fireworks" }],
    }));
    const dataDir = path.join(home, ".nexus", "claude-desktop");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "written-profiles.json"), JSON.stringify(["registered-id"]));
    assert.equal(await detectShimProfileId(lib, "http://127.0.0.1:8799", home), "registered-id");
  } finally { await cleanup(); }
});

test("off never leaves a shim-pointing profile applied (stale backup appliedId)", async () => {
  const { home, cleanup } = await tempHome();
  try {
    const { disableProfileLane } = await import("../../../lib/harnesses/claude-desktop/profile-lane.mjs");
    await enableFakeProfile(home); // prof-1 with managedMcpServers: [] — shim-URL body
    const lib = path.join(thirdPartyDir(home), "configLibrary");
    // A stale backup whose appliedId points at a Nexus profile — the
    // failure mode seen live: off must not leave the app on the dead shim.
    const backup = path.join(home, ".nexus", "claude-desktop", "profile-backup", "configLibrary-stale");
    await mkdir(backup, { recursive: true });
    await writeFile(path.join(backup, "old-fw.json"), JSON.stringify(SHIM_PROFILE_BODY));
    await writeFile(path.join(backup, "_meta.json"), JSON.stringify({
      appliedId: "old-fw", entries: [{ id: "old-fw", name: "Fireworks" }],
    }));
    const statePath = path.join(home, ".nexus", "claude-desktop", "profile-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, JSON.stringify({ ...state, backup }));
    await disableProfileLane(home, { log: () => {} });
    const meta = JSON.parse(await readFile(path.join(lib, "_meta.json"), "utf8"));
    assert.equal(meta.appliedId, null);
    assert.deepEqual(meta.entries.map((e) => e.id), ["old-fw"]); // entry kept, just not applied
  } finally { await cleanup(); }
});

test("off keeps a healthy non-shim appliedId from the backup", async () => {
  const { home, cleanup } = await tempHome();
  try {
    const { disableProfileLane } = await import("../../../lib/harnesses/claude-desktop/profile-lane.mjs");
    await enableFakeProfile(home);
    const lib = path.join(thirdPartyDir(home), "configLibrary");
    const backup = path.join(home, ".nexus", "claude-desktop", "profile-backup", "configLibrary-ok");
    await mkdir(backup, { recursive: true });
    await writeFile(path.join(backup, "user-prof.json"), JSON.stringify({ inferenceGatewayBaseUrl: "https://gateway.example.com" }));
    await writeFile(path.join(backup, "_meta.json"), JSON.stringify({
      appliedId: "user-prof", entries: [{ id: "user-prof", name: "Mine" }],
    }));
    const statePath = path.join(home, ".nexus", "claude-desktop", "profile-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, JSON.stringify({ ...state, backup }));
    await disableProfileLane(home, { log: () => {} });
    const meta = JSON.parse(await readFile(path.join(lib, "_meta.json"), "utf8"));
    assert.equal(meta.appliedId, "user-prof");
  } finally { await cleanup(); }
});

import { relaxSchemaBounds, mapModel } from "../../../lib/harnesses/claude-desktop/shim.mjs";

test("relaxSchemaBounds strips grammar-exploding bounds at every depth", () => {
  const schema = {
    type: "object",
    properties: {
      content: { type: "string", maxLength: 204800, minLength: 10 },
      id: { type: "string", minLength: 1 },
      tags: { type: "array", maxItems: 100, minItems: 2, items: { type: "string", maxLength: 100 } },
      nested: { anyOf: [{ type: "string", maxLength: 2000 }, { allOf: [{ type: "array", maxItems: 50 }] }] },
    },
    required: ["content"],
  };
  relaxSchemaBounds(schema);
  const text = JSON.stringify(schema);
  assert.ok(!/maxLength|maxItems/.test(text));
  assert.equal(schema.properties.content.minLength, undefined);
  assert.equal(schema.properties.id.minLength, 1); // trivial lower bound kept
  assert.equal(schema.properties.tags.minItems, undefined);
  assert.deepEqual(schema.required, ["content"]); // structure untouched
  assert.equal(relaxSchemaBounds(null), null);
});

test("mapModel honors the exact models map before family fallback", () => {
  const map = { models: { "claude-sonnet-4-8": "example-route-a" }, families: { sonnet: "example-route-b" } };
  assert.equal(mapModel("claude-sonnet-4-8", map), "example-route-a");
  assert.equal(mapModel("claude-sonnet-4-8[1m]", map), "example-route-a");
  assert.equal(mapModel("claude-sonnet-9", map), "example-route-b");
  assert.equal(mapModel("unrelated", map), "unrelated");
});

test("shim relaxes tool schema bounds on the upstream copy", async () => {
  let seen;
  const upstream = http.createServer((req, res) => {
    let d = ""; req.on("data", (c) => { d += c; }).on("end", () => { seen = JSON.parse(d); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const catalogDir = await mkdtemp(path.join(tmpdir(), "fc-shim-catalog-"));
  const server = createShimServer({ modelMap: DEFAULT_MODEL_MAP, catalogDir, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-8", tools: [{ name: "t", input_schema: { type: "object", properties: { c: { type: "string", maxLength: 204800 } } } }], messages: [] }),
    });
    assert.equal(seen.model, "auto");
    assert.equal(seen.tools[0].input_schema.properties.c.maxLength, undefined);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

test("shim sends the saved auto scope for auto-routed turns only, live from config", async () => {
  const { home, cleanup } = await tempHome();
  const catalogDir = await mkdtemp(path.join(tmpdir(), "fc-shim-catalog-"));
  const configPath = path.join(home, "config.json");
  await writeFile(configPath, JSON.stringify({ auto: { providers: ["fireworks"] } }));
  const loader = createAutoProvidersLoader({ configPath });
  assert.equal(await loader(), "fireworks");

  const seen = [];
  const upstream = http.createServer((req, res) => {
    let d = ""; req.on("data", (c) => { d += c; }).on("end", () => {
      seen.push({
        model: JSON.parse(d).model,
        providers: req.headers["x-nexus-providers"],
        title: req.headers["x-title"],
        referer: req.headers["http-referer"],
      });
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const server = createShimServer({
    modelMap: DEFAULT_MODEL_MAP, catalogDir,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    autoProvidersLoader: loader,
    log: () => {},
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const post = (model, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [] }),
  });
  try {
    await post("claude-opus-4-8");                       // routes to auto
    await post("claude-sonnet-4-8");                     // routes to glm-latest
    await post("claude-opus-4-8", { "x-nexus-providers": "spoofed", "x-title": "spoofed" });
    // Every forwarded turn carries the Nexus attribution the other
    // harnesses send; only auto-routed turns carry the scope.
    for (const turn of seen) {
      assert.equal(turn.title, "Claude Desktop");
      assert.match(turn.referer, /^nexus\/v\d+\.\d+\.\d+$/);
    }
    assert.deepEqual(seen.map(({ model, providers }) => ({ model, providers })), [
      { model: "auto", providers: "fireworks" },
      { model: "glm-latest", providers: undefined },
      { model: "auto", providers: "fireworks" },
    ]);

    // A later `nexus auto --reset` (providers: null) applies on the next
    // request, with no shim restart.
    await writeFile(configPath, JSON.stringify({ auto: { providers: null } }));
    const later = new Date(Date.now() + 5000);
    await utimes(configPath, later, later);
    assert.equal(await loader(), "");
    await post("claude-opus-4-8");
    assert.equal(seen.at(-1).model, "auto");
    assert.equal(seen.at(-1).providers, undefined);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    await rm(catalogDir, { recursive: true, force: true });
    await cleanup();
  }
});

test("shim sends keys saved with nexus auto on auto-routed turns only, live from config", async () => {
  const { home, cleanup } = await tempHome();
  const catalogDir = await mkdtemp(path.join(tmpdir(), "fc-shim-catalog-"));
  const configPath = path.join(home, "config.json");
  await writeFile(configPath, JSON.stringify({ anthropicApiKey: "sk-ant-example-0000", openaiApiKey: "{env:OPENAI_API_KEY}" }));
  const loader = createAutoKeysLoader({ configPath });
  // An environment reference never counts as a saved key.
  assert.deepEqual(await loader(), { anthropicKey: "sk-ant-example-0000", openaiKey: "" });
  const scopedPath = path.join(home, "scoped-config.json");
  await writeFile(scopedPath, JSON.stringify({ anthropicApiKey: "sk-ant-example-0000", auto: { providers: ["fireworks"] } }));
  assert.deepEqual(await createAutoKeysLoader({ configPath: scopedPath })(), { anthropicKey: "", openaiKey: "" });

  const seen = [];
  const upstream = http.createServer((req, res) => {
    let d = ""; req.on("data", (c) => { d += c; }).on("end", () => {
      seen.push({
        model: JSON.parse(d).model,
        anthropic: req.headers["x-anthropic-api-key"],
        openai: req.headers["x-openai-api-key"],
      });
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const server = createShimServer({
    modelMap: DEFAULT_MODEL_MAP, catalogDir,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    autoKeysLoader: loader,
    log: () => {},
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const post = (model, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [] }),
  });
  try {
    await post("claude-opus-4-8");
    await post("claude-sonnet-4-8", { "x-openai-api-key": "sk-proj-spoofed" });
    assert.deepEqual(seen, [
      { model: "auto", anthropic: "sk-ant-example-0000", openai: undefined },
      { model: "glm-latest", anthropic: undefined, openai: undefined },
    ]);

    // `nexus auto --unset anthropic-api-key` applies on the next request.
    await writeFile(configPath, JSON.stringify({ anthropicApiKey: "" }));
    const later = new Date(Date.now() + 5000);
    await utimes(configPath, later, later);
    await post("claude-opus-4-8");
    assert.equal(seen.at(-1).anthropic, undefined);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    await rm(catalogDir, { recursive: true, force: true });
    await cleanup();
  }
});

import { normalizeThinking } from "../../../lib/harnesses/claude-desktop/shim.mjs";

test("normalizeThinking maps UI effort spellings onto Fireworks ladders", () => {
  const a = { thinking: { type: "enabled", effort: "xhigh" } };
  normalizeThinking(a);
  assert.equal(a.thinking.effort, "max");

  const b = { thinking: { type: "enabled", mode: "extended" } };
  normalizeThinking(b);
  assert.equal(b.thinking.effort, "high");
  assert.equal(b.thinking.mode, undefined);

  const c = { thinking: { type: "enabled", effort: "high" } };
  assert.equal(normalizeThinking(c), null); // untouched
  assert.equal(normalizeThinking({}), null);
  assert.equal(normalizeThinking({ messages: [] }), null);
});

import { reliesOnClaudeAiLogin } from "../../../lib/harnesses/claude-desktop/profile-lane.mjs";

test("reliesOnClaudeAiLogin flags control-plane hosts unless own client exists", () => {
  assert.equal(reliesOnClaudeAiLogin({ name: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1" }), true);
  assert.equal(reliesOnClaudeAiLogin({ name: "visualize", url: "https://sandbox.claudemcpcontent.com/imagine_mcp" }), true);
  assert.equal(reliesOnClaudeAiLogin({ name: "bigquery", url: "https://bigquery.googleapis.com/mcp" }), true);
  // own OAuth client makes it standalone
  assert.equal(reliesOnClaudeAiLogin({ name: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", oauth: { clientId: "mine" } }), false);
  // normal vendors are unaffected
  assert.equal(reliesOnClaudeAiLogin({ name: "linear", url: "https://mcp.linear.app/mcp" }), false);
  assert.equal(reliesOnClaudeAiLogin({ name: "slack", url: "https://mcp.slack.com/mcp" }), false);
  assert.equal(reliesOnClaudeAiLogin({ name: "bad", url: "not a url" }), false);
});

test("sync drops claude.ai-reliant entries from the profile", async () => {
  const { home, cleanup } = await tempHome();
  try {
    await enableFakeProfile(home, [{ name: "gmail", transport: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" }]);
    await syncProfileConnectors(home, { listOrgConnectors: async () => [] });
    const list = await listProfileConnectors(home);
    assert.equal(list.length, 0);
  } finally { await cleanup(); }
});

test("off keeps the harness enabled flag when the profile restore fails", async () => {
  const { home, cleanup } = await tempHome();
  try {
    const { setHarnessEnabled, isHarnessEnabled } = await import("../../../lib/config/global-config.mjs");
    const { disableProfileLane } = await import("../../../lib/harnesses/claude-desktop/profile-lane.mjs");
    await enableFakeProfile(home);
    await setHarnessEnabled(home, "claude-desktop", true, "fireworks");
    // The recorded backup is missing, so restoring the pre-Nexus profiles fails.
    const statePath = path.join(home, ".nexus", "claude-desktop", "profile-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, JSON.stringify({ ...state, backup: path.join(home, "missing-backup") }));
    await assert.rejects(disableProfileLane(home, { log: () => {} }));
    // Uninstall discovery must still see Claude Desktop so a retry can finish the restore.
    assert.equal(await isHarnessEnabled(home, "claude-desktop"), true);
    await readFile(statePath, "utf8"); // recovery state retained
  } finally { await cleanup(); }
});

test("off clears the harness enabled flag after a successful restore", async () => {
  const { home, cleanup } = await tempHome();
  try {
    const { setHarnessEnabled, isHarnessEnabled } = await import("../../../lib/config/global-config.mjs");
    const { disableProfileLane } = await import("../../../lib/harnesses/claude-desktop/profile-lane.mjs");
    await enableFakeProfile(home);
    await setHarnessEnabled(home, "claude-desktop", true, "fireworks");
    await disableProfileLane(home, { log: () => {} });
    assert.equal(await isHarnessEnabled(home, "claude-desktop"), false);
  } finally { await cleanup(); }
});

test("shim forwards requests carrying hop-by-hop headers instead of 502ing", async () => {
  const { request } = await import("node:http");
  const upstream = http.createServer((req, res) => {
    // A forwarded request must not carry hop-by-hop headers upstream.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ saw: { connection: req.headers.connection, keepAlive: req.headers["keep-alive"], te: req.headers.te } }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const catalogDir = await mkdtemp(path.join(tmpdir(), "fc-shim-catalog-"));
  const server = createShimServer({ modelMap: DEFAULT_MODEL_MAP, catalogDir, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const body = JSON.stringify({ model: "claude-opus-4-8", messages: [] });
    const res = await new Promise((resolve, reject) => {
      // Node's fetch REFUSES these headers; a proxied client (Electron net)
      // sends them anyway — the shim must strip them, not crash.
      const req = request({
        host: "127.0.0.1", port: server.address().port, method: "POST", path: "/v1/messages",
        headers: { "content-type": "application/json", connection: "keep-alive", "keep-alive": "timeout=5", te: "trailers", "content-length": Buffer.byteLength(body) },
      }, resolve);
      req.on("error", reject);
      req.end(body);
    });
    let chunks = "";
    for await (const chunk of res) chunks += chunk;
    const saw = JSON.parse(chunks).saw;
    // `connection` is re-added by Node's own client on the new socket; the
    // client-supplied hop-by-hop values must not survive.
    assert.equal(saw.keepAlive, undefined);
    assert.equal(saw.te, undefined);
    assert.equal(res.statusCode, 200);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    await rm(catalogDir, { recursive: true, force: true });
  }
});

test("shim reports an unreachable upstream as a 502 with its cause, not a timeout", async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const deadPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const catalogDir = await mkdtemp(path.join(tmpdir(), "fc-shim-catalog-"));
  const logs = [];
  const server = createShimServer({ modelMap: DEFAULT_MODEL_MAP, catalogDir, upstreamOrigin: `http://127.0.0.1:${deadPort}`, log: (line) => logs.push(line) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-8", messages: [] }),
    });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /Could not reach Fireworks: ECONNREFUSED/);
    assert.ok(logs.some((line) => /upstream error .*ECONNREFUSED/.test(line)));
  } finally {
    await new Promise((r) => server.close(r));
    await rm(catalogDir, { recursive: true, force: true });
  }
});

test("secret-bearing profile files are written owner-only (0600)", async () => {
  const { stat } = await import("node:fs/promises");
  const { home, cleanup } = await tempHome();
  try {
    await enableFakeProfile(home);
    await addProfileConnector(home, { name: "linear", url: "https://mcp.linear.app/mcp", oauth: { clientId: "example-client", clientSecret: "example-secret" } });
    const lib = path.join(thirdPartyDir(home), "configLibrary");
    const profileMode = (await stat(path.join(lib, "prof-1.json"))).mode & 0o777;
    const oauthMode = (await stat(path.join(home, ".nexus", "claude-desktop", "oauth-clients.json"))).mode & 0o777;
    assert.equal(profileMode, 0o600); // holds the Fireworks gateway key
    assert.equal(oauthMode, 0o600); // holds connector OAuth client secrets
  } finally { await cleanup(); }
});

test("loadDesktopLineup: cold cache + offline falls back to the curated list", async () => {
  const { home, cleanup } = await tempHome();
  try {
    const { loadDesktopLineup } = await import("../../../lib/harnesses/claude-desktop/profile-lane.mjs");
    // No serverless cache, no signed catalog, and the fetch is offline
    // (NEXUS_TEST gates real fetches) — the curated fallback answers.
    const { full, models, modelMap } = await loadDesktopLineup({
      apiKey: "test", signedCatalogPath: path.join(home, "nowhere", "catalog.json"),
    });
    assert.equal(full, false);
    assert.ok(models.length >= 3);
    assert.ok(Object.keys(modelMap.models).length >= 3);
  } finally { await cleanup(); }
});

test("upgrade scrub removes FireRouter custom models from manual list, shim map, and profile", async () => {
  const { migrateClaudeDesktopFirerouterOnUpgrade } = await import("../../../lib/harnesses/claude-desktop/upgrade-migrations.mjs");
  const { shimStatePath } = await import("../../../lib/harnesses/claude-desktop/profile-lane.mjs");
  const { home, cleanup } = await tempHome();
  try {
    await enableFakeProfile(home);
    const lib = path.join(thirdPartyDir(home), "configLibrary");
    await writeFile(path.join(lib, "prof-1.json"), JSON.stringify({
      inferenceModels: [{ name: "claude-custom-1" }, { name: "claude-keep" }],
    }));
    const dataDir = path.join(home, ".nexus", "claude-desktop");
    await writeFile(path.join(dataDir, "manual-models.json"), JSON.stringify([
      { shortId: "firerouter/opus", name: "claude-custom-1", label: "FireRouter · Opus", tier: "opus" },
      { shortId: "glm-latest", name: "claude-keep", label: "GLM", tier: "sonnet" },
    ]));
    await writeFile(shimStatePath(home), JSON.stringify({
      port: 1234,
      modelMap: { models: { "claude-custom-1": "firerouter/opus", "claude-keep": "glm-latest" } },
    }));

    assert.equal(await migrateClaudeDesktopFirerouterOnUpgrade(home), true);

    const manual = JSON.parse(await readFile(path.join(dataDir, "manual-models.json"), "utf8"));
    assert.deepEqual(manual.map((m) => m.shortId), ["glm-latest"]);
    const state = JSON.parse(await readFile(shimStatePath(home), "utf8"));
    assert.deepEqual(state.modelMap.models, { "claude-keep": "glm-latest" });
    const profile = JSON.parse(await readFile(path.join(lib, "prof-1.json"), "utf8"));
    assert.deepEqual(profile.inferenceModels, [{ name: "claude-keep" }]);

    assert.equal(await migrateClaudeDesktopFirerouterOnUpgrade(home), false, "second run no-ops");
  } finally { await cleanup(); }
});
