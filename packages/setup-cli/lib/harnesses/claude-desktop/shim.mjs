#!/usr/bin/env node
/**
 * Nexus Desktop profile-lane shim (long-running; launched by launchd).
 *
 * Claude Desktop's third-party ("gateway") provider requires Anthropic-shaped
 * model names and answers to a couple of endpoints Fireworks does not serve.
 * This loopback shim sits between Desktop and the Fireworks Anthropic endpoint:
 *
 * - rewrites `claude-*` model names to the configured Fireworks routes
 * - translates Anthropic-style `x-api-key` auth to `Authorization: Bearer`
 * - answers /v1/messages/count_tokens locally (Fireworks 404s it)
 * - mirrors Anthropic's signed model catalog byte-for-byte (the app verifies
 *   it against a built-in key; a local cache keeps it working offline)
 *
 * Robustness rules (AGENTS.md): every upstream call is raced with a timeout,
 * every failure degrades to a cached/local answer, and nothing throws past
 * the request boundary. Message content is never logged.
 */
import "../../system/legacy-env.mjs";
import http from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
// Only the pure leaf: the shim must not pull the CLI's full module graph.
import { serverlessLineup, thirdPartyDir } from "./lineup.mjs";
import { autoCatalogEntry, autoCatalogEntryId } from "../../fireworks/models.mjs";
import {
  NEXUS_PROVIDERS_HEADER,
  formatAutoProviders,
  normalizeAutoProviders,
} from "../../config/auto-providers.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { buildFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";

const UPSTREAM = "https://api.fireworks.ai/inference";
const UPSTREAM_TIMEOUT_MS = 300_000; // long prefills (800k+ tokens) legitimately take minutes
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const EST_CHARS_PER_TOKEN = 4;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

/**
 * Fireworks compiles tool input schemas into a constrained-decoding grammar,
 * and length/item bounds expand into rules multiplicatively — one connector
 * with a maxLength of 204800 pushes a request past the rule limit (400
 * "tool schema is too complex"). Drop those bounds from the copy sent
 * upstream; the MCP server still validates arguments when the tool runs.
 * Trivial lower bounds (0 or 1) are cheap and kept.
 */
export function relaxSchemaBounds(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 64) return schema;
  if (Array.isArray(schema)) {
    for (const item of schema) relaxSchemaBounds(item, depth + 1);
    return schema;
  }
  delete schema.maxLength;
  delete schema.maxItems;
  if (typeof schema.minLength === "number" && schema.minLength > 1) delete schema.minLength;
  if (typeof schema.minItems === "number" && schema.minItems > 1) delete schema.minItems;
  for (const value of Object.values(schema)) {
    if (value && typeof value === "object") relaxSchemaBounds(value, depth + 1);
  }
  return schema;
}

/**
 * Normalize Anthropic-side thinking/effort values to what the Fireworks
 * routes accept. The picker labels come from the borrowed catalog ids
 * ("Extra" = xhigh, "Extended" = haiku's thinking mode), but the shared
 * reasoning ladders for these models are low/medium/high/max — so map the
 * two spellings the ladders don't advertise onto the nearest supported one
 * (xhigh -> max, extended -> high) instead of risking a 400.
 */
const EFFORT_REWRITE = { xhigh: "max", extended: "high" };

export function normalizeThinking(body) {
  const thinking = body?.thinking;
  if (!thinking || typeof thinking !== "object") return null;
  const before = thinking.effort ?? thinking.mode;
  if (thinking.effort && EFFORT_REWRITE[thinking.effort]) {
    thinking.effort = EFFORT_REWRITE[thinking.effort];
  }
  if (!thinking.effort && thinking.mode && EFFORT_REWRITE[thinking.mode]) {
    thinking.effort = EFFORT_REWRITE[thinking.mode];
    delete thinking.mode;
  }
  const after = thinking.effort ?? thinking.mode;
  return before !== after ? `${before} -> ${after}` : null;
}

/** Map a claude-* display name to the configured Fireworks route. */
export function mapModel(name, modelMap) {
  if (typeof name !== "string") return name;
  // Desktop's 1M-context variant marker is client-side; route the base model.
  name = name.replace(/\[1m\]$/i, "");
  const exact = modelMap?.models;
  if (exact && Object.hasOwn(exact, name)) return exact[name];
  const lower = name.toLowerCase();
  for (const [family, target] of Object.entries(modelMap?.families ?? {})) {
    if (lower.includes(family)) return target;
  }
  return name;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
  });
}

/**
 * Hop-by-hop headers (RFC 7230 plus proxy variants): Node's fetch THROWS on
 * some of them ("invalid keep-alive header" etc.), so a forwarded request
 * carrying one would 502. They never describe the payload; drop them.
 */
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

/**
 * Live lineup from the caches: the picker discovers models via /v1/models
 * (the profile carries no inferenceModels), and name mapping uses the same
 * pairing, so a refreshed serverless cache shows up on the next request —
 * no `nexus claude-desktop on` re-run, no Desktop restart beyond the
 * app's own /v1/models poll. Cold caches fall back to the curated 3-model
 * map written at `on` time (shim-state.json).
 */
export function createLineupLoader({ modelsCachePath, catalogDir, fallback }) {
  let memo = null;
  return async function currentLineup() {
    try {
      const [ms, cs] = await Promise.all([
        stat(modelsCachePath).then((s) => s.mtimeMs).catch(() => 0),
        stat(path.join(catalogDir, "catalog.json")).then((s) => s.mtimeMs).catch(() => 0),
      ]);
      if (memo?.key === `${ms}:${cs}`) return memo.value;
      const serverless = await readJson(modelsCachePath);
      const catalog = await readJson(path.join(catalogDir, "catalog.json"));
      const entries = Array.isArray(serverless?.entries) ? serverless.entries
        : Array.isArray(serverless?.snapshot?.entries) ? serverless.snapshot.entries : [];
      // The on-disk snapshot omits the auto mixes (loadServerlessCatalog
      // synthesizes them in-process); add them so the shim matches the CLI.
      if (!entries.some((e) => autoCatalogEntryId(e))) entries.push(autoCatalogEntry());
      const lineup = serverlessLineup(entries, catalog);
      // Custom models (on --model …) aren't in the lineup: merge their routes
      // into the live map so requests work between poller ticks too. The store
      // is durable (off-safe): manual-models.json.
      if (lineup) {
        const custom = await readJson(path.join(path.dirname(modelsCachePath), "claude-desktop", "manual-models.json")) ?? [];
        for (const m of custom) {
          if (!lineup.models.some((e) => e.name === m.name)) {
            lineup.models.push({ name: m.name, labelOverride: m.label, anthropicFamilyTier: m.tier, isFamilyDefault: false });
          }
          lineup.modelMap.models[m.name] = m.shortId;
        }
      }
      memo = { key: `${ms}:${cs}`, value: lineup ?? fallback() };
      return memo.value;
    } catch {
      return fallback();
    }
  };
}

/**
 * Live `nexus auto` scope from the global config: the formatted providers
 * value to send for auto-routed turns, or "" when no scope is saved.
 * Memoized on the config file's mtime (like the lineup loader), so a
 * `nexus auto` change takes effect on the next request — no re-`on`, no
 * Desktop restart. A missing/unreadable config reads as no scope, and
 * forwarding never waits on or fails over it.
 * @param {{ configPath: string }} opts
 */
export function createAutoProvidersLoader({ configPath }) {
  let memo = null;
  return async function currentAutoProviders() {
    try {
      const mtime = await stat(configPath).then((s) => s.mtimeMs).catch(() => 0);
      if (memo?.mtime === mtime) return memo.value;
      const config = mtime ? await readJson(configPath) : null;
      const value = formatAutoProviders(normalizeAutoProviders(config?.auto?.providers));
      memo = { mtime, value };
      return value;
    } catch {
      return "";
    }
  };
}

/** Copy upstream response headers, dropping the hop-by-hop ones. */
function copyUpstreamHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) {
    if (!HOP_HEADERS.has(k) && k !== "content-encoding") out[k] = v;
  }
  return out;
}

function reply(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": typeof payload === "string" ? "text/plain" : "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

export function createShimServer({
  modelMap, catalogDir, upstreamOrigin = UPSTREAM, log = console.log,
  // When provided, requests resolve the model map and discovery list from
  // this live loader (serverless cache + signed catalog) instead of the
  // static modelMap.
  lineupLoader = null,
  // When provided, resolves the current `nexus auto` providers value
  // ("" = no scope). Sent only for turns routed to an auto model.
  autoProvidersLoader = null,
}) {
  const currentModelMap = async () => (lineupLoader ? (await lineupLoader()).modelMap : modelMap) ?? modelMap;
  // The Nexus attribution every other harness puts on its gateway traffic.
  // Desktop's own `on` is bespoke, so the shim is where these are added.
  const telemetryHeaders = buildFireconnectTelemetryHeaders(HARNESS.CLAUDE_DESKTOP);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return reply(res, 200, "ok");

      const body = await readBody(req);

      // Health probe: count_tokens — estimate locally (~4 chars/token).
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        let parsed = {};
        try { parsed = JSON.parse(body.toString("utf8") || "{}"); } catch { /* estimate from raw */ }
        const text = parsed.messages ? JSON.stringify(parsed.messages) + (parsed.system ?? "") : body.toString("utf8");
        return reply(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / EST_CHARS_PER_TOKEN)) });
      }

      // Everything else: proxy upstream, rewriting the model field if present.
      let outBody = body;
      let toolSummary = "";
      let debugTools = null;
      let routedModel = null;
      if (body.length && (req.headers["content-type"] || "").includes("application/json")) {
        try {
          const parsed = JSON.parse(body.toString("utf8"));
          if (parsed.model) {
            const liveMap = await currentModelMap();
            const mapped = mapModel(parsed.model, liveMap);
            routedModel = mapped;
            if (mapped !== parsed.model) parsed.model = mapped;
          }
          const effortRewrite = normalizeThinking(parsed);
          if (effortRewrite) log(`[nexus-shim] effort rewritten: ${effortRewrite}`);
          if (Array.isArray(parsed.tools)) {
            for (const tool of parsed.tools) {
              if (tool?.input_schema) relaxSchemaBounds(tool.input_schema);
            }
            toolSummary = `tools=${parsed.tools.length} kinds=${[...new Set(parsed.tools.map((t) => t?.type ?? "custom"))].join(",")}`;
            if (process.env.NEXUS_SHIM_DEBUG === "1") debugTools = parsed.tools;
          }
          outBody = Buffer.from(JSON.stringify(parsed));
        } catch { /* pass through verbatim */ }
      }

      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (HOP_HEADERS.has(name) || name === "host" || name === "content-length") continue;
        headers[name] = value;
      }
      headers["content-length"] = Buffer.byteLength(outBody);
      // Desktop's 3p provider sends the key Anthropic-style; Fireworks wants Bearer.
      if (headers["x-api-key"] && !headers.authorization) {
        headers.authorization = `Bearer ${headers["x-api-key"]}`;
        delete headers["x-api-key"];
      }
      // Nexus attribution, owned by Nexus like the scope below: replace
      // any inbound copies (Node lowercases inbound header names).
      delete headers["x-title"];
      delete headers["http-referer"];
      Object.assign(headers, telemetryHeaders);
      // The `nexus auto` scope belongs to Nexus, not the client: drop any
      // inbound copy, then set the current one for auto-routed turns only.
      delete headers[NEXUS_PROVIDERS_HEADER];
      if (autoProvidersLoader
        && typeof routedModel === "string"
        && (routedModel === "auto" || routedModel.startsWith("auto-"))) {
        const providers = await autoProvidersLoader().catch(() => "");
        if (providers) headers[NEXUS_PROVIDERS_HEADER] = providers;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      let upstream;
      try {
        upstream = await fetch(upstreamOrigin + url.pathname + url.search, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : outBody,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (error.name === "AbortError") {
          log(`[nexus-shim] upstream timeout for ${req.method} ${url.pathname}`);
          return reply(res, 504, { error: { type: "timeout_error", message: "Upstream timed out." } });
        }
        // Surface the code: a TLS-inspecting proxy shows up as a cert error here.
        const cause = error.cause?.code ?? error.cause?.message ?? error.message;
        log(`[nexus-shim] upstream error for ${req.method} ${url.pathname}: ${cause}`);
        return reply(res, 502, { error: { type: "api_error", message: `Could not reach Fireworks: ${cause}` } });
      }
      clearTimeout(timer);
      log(`[nexus-shim] upstream ${upstream.status} for ${req.method} ${url.pathname}${toolSummary ? ` ${toolSummary}` : ""}`);
      if (upstream.status === 400 && debugTools) {
        // Diagnostics only (opt-in): tool names and sizes, never message content.
        const sizes = debugTools.map((t) => [t?.name ?? t?.type, JSON.stringify(t).length]).sort((a, b) => b[1] - a[1]).slice(0, 15);
        log(`[nexus-shim] 400 largest tools: ${sizes.map(([n, z]) => `${n}:${z}`).join(" ")}`);
      }

      res.writeHead(upstream.status, copyUpstreamHeaders(upstream.headers));
      if (upstream.body) {
        // Status-only usage telemetry: a second data listener watches the SSE
        // stream for usage deltas and logs the true token count. Never logs
        // message content. (pipe keeps backpressure; both listeners see data.)
        const nodeStream = Readable.fromWeb(upstream.body);
        {
          let pending = "";
          nodeStream.on("data", (chunk) => {
            // Carry over only the last (possibly incomplete) line; complete
            // lines are scanned exactly once.
            const text = pending + chunk.toString("utf8");
            const lines = text.split("\n");
            pending = lines.pop();
            for (const line of lines) {
              const m = /"type":"message_delta".*"usage":(\{[^}]*\})/.exec(line);
              if (m) {
                try {
                  const u = JSON.parse(m[1]);
                  const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
                  if (total > 0) log(`[nexus-shim] usage ${total} in (${u.cache_read_input_tokens ?? 0} cached)`);
                } catch {}
              }
            }
          });
          // A dropped upstream body must end the client response; a client
          // stop (user aborted) must end the upstream request — otherwise
          // generation keeps running (and billing) with no one attached.
          nodeStream.on("error", () => res.destroy());
          res.once("close", () => nodeStream.destroy());
        }
        nodeStream.pipe(res);
      } else res.end();
    } catch (error) {
      if (!res.headersSent) reply(res, 502, { error: { message: String(error?.message ?? error) } });
      else res.destroy();
    }
  });
}

async function main() {
  const home = argValue("--home") ?? process.env.HOME ?? "";
  const dataDir = path.join(home, ".nexus", "claude-desktop");
  const state = (await readJson(path.join(dataDir, "shim-state.json"))) ?? {};
  const port = Number(state.port) > 0 ? Number(state.port) : 8799;
  const catalogDir = path.join(dataDir, "catalog");
  const lineupLoader = createLineupLoader({
    modelsCachePath: path.join(home, ".nexus", "catalog-cache.json"),
    catalogDir,
    fallback: () => ({ modelMap: state.modelMap ?? {}, models: [] }),
  });
  const server = createShimServer({
    modelMap: state.modelMap,
    catalogDir,
    lineupLoader,
    autoProvidersLoader: createAutoProvidersLoader({
      configPath: path.join(home, ".nexus", "config.json"),
    }),
    // The harness matrix's CI loopback; never honored outside tests, so a
    // stray variable can't send a real key elsewhere.
    ...(process.env.NEXUS_TEST === "1" && process.env.NEXUS_SHIM_UPSTREAM
      ? { upstreamOrigin: process.env.NEXUS_SHIM_UPSTREAM } : {}),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`[nexus-shim] listening on 127.0.0.1:${port}`);

  // Keep the applied profile's model list in sync with the live lineup: the
  // profile is static (Desktop reads it at launch), so when the serverless
  // cache changes the shim rewrites inferenceModels — preserving connectors —
  // and the next app launch shows the new model without re-running `on`.
  let lastModelNames = "";
  setInterval(async () => {
    try {
      const lineup = await lineupLoader();
      if (!lineup?.models?.length) return;
      // Custom models (on --model …) aren't in the lineup: keep them, and
      // route their ids in the live map. The store is durable (off-safe).
      const custom = await readJson(path.join(dataDir, "manual-models.json")) ?? [];
      for (const m of custom) {
        if (!lineup.models.some((e) => e.name === m.name)) {
          lineup.models.push({ name: m.name, labelOverride: m.label, anthropicFamilyTier: m.tier, isFamilyDefault: false });
        }
        lineup.modelMap.models[m.name] = m.shortId;
      }
      const names = lineup.models.map((m) => m.name).join(",");
      if (names === lastModelNames) return;
      lastModelNames = names;
      const stateFile = path.join(dataDir, "profile-state.json");
      const profileState = await readJson(stateFile);
      if (!profileState?.enabled || !profileState.profileId) return;
      const profilePath = path.join(thirdPartyDir(home), "configLibrary", `${profileState.profileId}.json`);
      const profile = await readJson(profilePath);
      if (!profile) return;
      const current = (Array.isArray(profile.inferenceModels) ? profile.inferenceModels : []).map((m) => m.name).join(",");
      if (current === names) return;
      profile.inferenceModels = lineup.models.map(({ route: _route, ...entry }) => entry);
      await writeFileAtomic(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
      console.log(`[nexus-shim] model list refreshed in the profile (${lineup.models.length} entries; restart Desktop to see them)`);
    } catch (error) {
      console.log(`[nexus-shim] model-list refresh skipped: ${error?.message ?? error}`);
    }
  }, 30_000).unref();
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((error) => { console.error(error); process.exit(1); });
