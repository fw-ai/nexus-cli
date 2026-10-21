/**
 * Real-tool driver for `nexus claude demo`'s race.
 *
 * Spawns a `claude -p` (Claude Code, headless) process using the user's
 * Nexus-managed profile and parses its `--output-format stream-json` stdout.
 */

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import readline from "node:readline";
import { FIRST_TOKEN_TIMEOUT_MS, HARD_RUN_CAP_MS } from "./constants.mjs";
import { FIREWORKS_ENV_KEYS } from "../harnesses/claude/core.mjs";
import { CLAUDE_FIREROUTER_ENV_KEYS } from "../firerouter/core.mjs";
import { computeClaudeUsageCost } from "../harnesses/claude/usage/pricing.mjs";
import { isFirerouterModelPattern } from "../fireworks/model-specs.mjs";
import { lookupFireworksPricing } from "../fireworks/pricing.mjs";
import { stripClaudeCodeContextSuffix } from "../harnesses/claude/code-context.mjs";

// Only stripped when racing in an isolated CLAUDE_CONFIG_DIR (legacy path).
const STRIP_CHILD_ENV_KEYS = new Set([...FIREWORKS_ENV_KEYS, ...CLAUDE_FIREROUTER_ENV_KEYS]);

/**
 * @param {Record<string, string>} env
 * @param {string} configDir
 * @returns {Record<string, string>}
 */
function buildIsolatedChildEnv(env, configDir) {
  const next = {};
  for (const [k, v] of Object.entries(env)) {
    if (!STRIP_CHILD_ENV_KEYS.has(k)) {
      next[k] = v;
    }
  }
  next.CLAUDE_CONFIG_DIR = configDir;
  return next;
}

/**
 * Pure parser for one `stream-json` event (a single decoded JSON object from
 * the tool's stdout). Returns the bits the runner accumulates. Exported for
 * unit testing — no `claude` binary needed.
 *
 * @param {any} obj
 * @returns {{
 *   deltas?: string[],
 *   thinkingDeltas?: string[],
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   result?: string,
 *   isResult?: boolean,
 *   error?: string,
 *   status?: string,
 * }}
 */
export function parseStreamJson(obj) {
  if (!obj || typeof obj !== "object") {
    return {};
  }
  const out = { deltas: [], thinkingDeltas: [] };

  if (obj.type === "stream_event" && obj.event) {
    const ev = obj.event;
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta"
        && typeof ev.delta.text === "string" && ev.delta.text.length > 0) {
      out.deltas.push(ev.delta.text);
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
      // Reasoning tokens (GLM, DeepSeek): shown in the pane body (dimmed, above
      // the final code), not mixed into the app-output buffer.
      const thinking = ev.delta.thinking ?? ev.delta.text;
      if (typeof thinking === "string" && thinking.length > 0) {
        out.thinkingDeltas.push(thinking);
        out.status = "Thinking…";
      } else {
        // Anthropic ships ENCRYPTED thinking: the block arrives as
        // `{thinking: "", signature: "<~2kb>"}`, i.e. proof that reasoning
        // happened with no text to render. Say so rather than leaving the pane
        // blank under a status that implies output is coming.
        out.status = "Reasoning (not exposed by provider)…";
      }
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "signature_delta") {
      // The signature half of an encrypted thinking block — same story.
      out.status = "Reasoning (not exposed by provider)…";
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
      // A tool call's arguments stream as partial JSON. Agentic models (Opus 5
      // and friends) write the app with the Write tool instead of emitting it as
      // text, so the file body arrives here — NOT as text_delta. Without this the
      // pane sits empty while tokens and cost climb. The runner accumulates these
      // fragments and decodes the file content out of them.
      if (typeof ev.delta.partial_json === "string") {
        out.toolInputJson = ev.delta.partial_json;
      }
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
      out.textBlockStart = true;
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      out.status = `Running ${ev.content_block.name || "tool"}…`;
      out.toolUseStart = { name: ev.content_block.name || "tool" };
    } else if (ev.type === "content_block_stop") {
      out.contentBlockStop = true;
    } else if (ev.type === "message_start") {
      // A new assistant message begins — a boundary for token accumulation
      // across an agentic (multi-message) turn.
      out.messageStart = true;
      // Not "responding" — message_start fires before any content is emitted,
      // and Opus can reason silently (encrypted thinking, only signature_delta
      // on the wire) for a long time before the first text delta. Saying
      // "responding" over an empty pane reads as a stall.
      out.status = "Model reasoning — no output yet…";
      // The model that ACTUALLY served the request — not the alias we asked for.
      // See the `assistant` branch for why this is what pricing must use.
      if (typeof ev.message?.model === "string" && ev.message.model) {
        out.resolvedModel = ev.message.model;
      }
      if (typeof ev.message?.usage?.input_tokens === "number") {
        out.inputTokens = ev.message.usage.input_tokens;
      }
      // Prompt-caching tokens (Anthropic). Cache WRITES are billed at a premium
      // over the base input rate and differ by TTL (5m vs 1h); cache READS are
      // billed at a steep discount. See the result branch for the full breakdown.
      Object.assign(out, extractCacheTokens(ev.message?.usage));
    } else if (ev.type === "message_delta" && ev.usage) {
      // message_delta.usage.output_tokens is cumulative for the turn.
      if (typeof ev.usage.output_tokens === "number") {
        out.outputTokens = ev.usage.output_tokens;
      }
    } else if (ev.type === "error" || ev.error) {
      out.error = ev.error?.message || ev.message || JSON.stringify(ev);
    }
    return out;
  }

  if (obj.type === "assistant") {
    // Each assistant message names the model that actually served it. This is
    // the ONLY reliable price key: the `--model` argument is often an alias that
    // resolves to something else — `firerouter[1m]` and even `glm-fast-latest[1m]`
    // both report `accounts/fireworks/models/glm-5p2`. Pricing by the requested
    // alias therefore bills the wrong model (and for firerouter there is no
    // alias price at all, so it fell through to a generic reference rate).
    // This is the same per-message model `claude usage`/`claude live` price from.
    if (typeof obj.message?.model === "string" && obj.message.model) {
      out.resolvedModel = obj.message.model;
    }
    return out;
  }

  if (obj.type === "system") {
    // System events carry no deltas, but their subtype is a phase we can show
    // while waiting on the first token (init = tool booted, api_retry = a
    // transient upstream retry the tool handles itself).
    if (obj.subtype === "init") {
      out.status = "Claude Code ready · sending prompt";
    } else if (obj.subtype === "api_retry") {
      out.status = "Retrying…";
      // Claude Code is handling a transient upstream failure itself (e.g. a 529
      // Overloaded). Signal it so the runner can clear a sticky in-stream error.
      out.apiRetry = true;
    }
    return out;
  }

  if (obj.type === "result") {
    out.isResult = true;
    out.result = typeof obj.result === "string" ? obj.result : "";
    // The result event may carry total usage under any of these shapes.
    const u = obj.usage || obj.total_usage || obj.result?.usage;
    if (u) {
      if (typeof u.input_tokens === "number") out.inputTokens = u.input_tokens;
      if (typeof u.output_tokens === "number") out.outputTokens = u.output_tokens;
      // Prompt-caching tokens (Anthropic). Cache WRITES are billed at a premium
      // over the base input rate and differ by TTL (5m vs 1h); cache READS are
      // billed at a steep discount. Real Anthropic runs cache most of the
      // system+prompt, so usage.input_tokens is just the uncached remainder —
      // without splitting write/read and pricing each at its own rate, cost is
      // computed from a near-zero input count and wildly understated.
      Object.assign(out, extractCacheTokens(u));
      // Keep raw usage so the runner can price it with the same canonical
      // provider-rate engine as transcript reports and statusline.
      out.usage = u;
    }
    // Preserve Claude Code's own estimate for diagnostics. It can apply
    // Anthropic rates to Fireworks models, so it never drives demo pricing.
    if (typeof obj.total_cost_usd === "number" && obj.total_cost_usd > 0) {
      out.costUsd = obj.total_cost_usd;
    } else {
      const mu = obj.modelUsage;
      if (mu && typeof mu === "object") {
        let sum = 0;
        for (const stats of Object.values(mu)) {
          if (typeof stats?.costUSD === "number") sum += stats.costUSD;
        }
        if (sum > 0) out.costUsd = sum;
      }
    }
    // The session id identifies this run's Claude Code transcript, which is where
    // any cost/behavior question gets answered.
    if (typeof obj.session_id === "string" && obj.session_id) {
      out.sessionId = obj.session_id;
    }
    if (obj.subtype === "error" || obj.is_error || String(obj.subtype ?? "").startsWith("error")) {
      out.error = describeResultError(obj);
    }
    return out;
  }

  // `system` events (init / api_retry / plugin_install) carry no deltas; an
  // api_retry is non-fatal (the tool retries automatically). Nothing to emit.
  return out;
}

/**
 * Build an actionable message from an error `result` event.
 *
 * The old code was `obj.error || obj.result || "<generic>"`, and Claude Code
 * usually sets neither of those on a failure — so every failure surfaced as the
 * useless "claude result event indicated an error" with the real cause (an API
 * status, a turn-limit subtype, a stop reason) still sitting in the event.
 * Collect whatever the event actually carries instead.
 * @param {any} obj the result event
 * @returns {string}
 */
function describeResultError(obj) {
  const direct = typeof obj.error === "string" ? obj.error.trim() : "";
  if (direct) {
    return direct;
  }
  const nested = typeof obj.error?.message === "string" ? obj.error.message.trim() : "";
  if (nested) {
    return nested;
  }
  const parts = [];
  // `subtype` distinguishes the failure kind (error_max_turns,
  // error_during_execution, …) — the single most useful field.
  if (typeof obj.subtype === "string" && obj.subtype && obj.subtype !== "error") {
    parts.push(obj.subtype);
  }
  if (obj.api_error_status != null && obj.api_error_status !== "") {
    parts.push(`api status ${obj.api_error_status}`);
  }
  if (typeof obj.stop_reason === "string" && obj.stop_reason && obj.stop_reason !== "end_turn") {
    parts.push(`stop_reason ${obj.stop_reason}`);
  }
  if (typeof obj.terminal_reason === "string" && obj.terminal_reason && obj.terminal_reason !== "completed") {
    parts.push(`terminal ${obj.terminal_reason}`);
  }
  if (typeof obj.num_turns === "number" && obj.num_turns > 0) {
    parts.push(`after ${obj.num_turns} turn${obj.num_turns === 1 ? "" : "s"}`);
  }
  // The result text is often the provider's own message; keep it last and short.
  const text = typeof obj.result === "string" ? obj.result.trim() : "";
  if (text) {
    parts.push(text.slice(0, 300));
  }
  return parts.length > 0
    ? `claude run failed (${parts.join(" · ")})`
    : "claude run failed (result event reported an error with no detail; rerun with FC_DEBUG=1 for the raw stderr)";
}

/**
 * Decode a JSON string body (the text after an opening quote) as far as it can
 * be decoded safely, stopping at the closing quote or at a truncated escape.
 * The input is a STREAMING fragment, so it may end mid-escape (`\` or `\u12`) —
 * decoding those would corrupt the output, so we stop short and pick them up on
 * the next chunk.
 * @param {string} raw
 * @returns {string}
 */
function decodeJsonStringBody(raw) {
  const SIMPLE = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') break;            // closing quote — string complete
    if (ch !== "\\") { out += ch; i += 1; continue; }
    if (i + 1 >= raw.length) break;   // trailing backslash — escape not yet complete
    const esc = raw[i + 1];
    if (esc === "u") {
      if (i + 5 >= raw.length) break; // \uXXXX not fully arrived
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    if (Object.hasOwn(SIMPLE, esc)) { out += SIMPLE[esc]; i += 2; continue; }
    break;                            // unrecognized escape — stop rather than corrupt
  }
  return out;
}

/**
 * Tools whose arguments carry a file body worth streaming to the pane. Gating on
 * this matters: Claude Code usually calls TodoWrite first, and its todo items
 * also use a "content" field — without the allowlist those todo strings stream
 * into the pane as if they were the app.
 */
const FILE_WRITING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Pull the file body out of a partially-streamed tool-input JSON blob. `Write`
 * carries it under "content"; `Edit`/`MultiEdit` under "new_string". Returns the
 * decoded text so far ("" when the key hasn't arrived yet).
 * @param {string} json accumulated partial_json
 * @returns {string}
 */
function toolFileContentSoFar(json) {
  const key = /"(?:content|new_string)"\s*:\s*"/.exec(json);
  if (!key) {
    return "";
  }
  return decodeJsonStringBody(json.slice(key.index + key[0].length));
}

/**
 * Split Anthropic prompt-caching usage into priced buckets. `cache_creation`
 * carries the per-TTL write breakdown (ephemeral_1h / ephemeral_5m); when absent,
 * fall back to the aggregate `cache_creation_input_tokens` and assume 5m (the
 * cheaper, safer default — matches `computeClaudeUsageCost` in usage/pricing.mjs
 * so the demo and `claude usage` agree on identical session data). 1h writes
 * bill at a premium over 5m, so assuming 1h would overprice a flat-shape run.
 * `cache_read_input_tokens` is the read/hit bucket.
 * Each bucket is billed at a distinct rate (write 1h > write 5m > base input >
 * cache read), so they must stay separate.
 * @param {any} u usage object from a message_start or result event
 * @returns {{ cacheWrite1hTokens?: number, cacheWrite5mTokens?: number, cacheReadTokens?: number }}
 */
function extractCacheTokens(u) {
  if (!u || typeof u !== "object") {
    return {};
  }
  const out = {};
  const cc = u.cache_creation;
  const write1h = typeof cc?.ephemeral_1h_input_tokens === "number" ? cc.ephemeral_1h_input_tokens : null;
  const write5m = typeof cc?.ephemeral_5m_input_tokens === "number" ? cc.ephemeral_5m_input_tokens : null;
  if (write1h != null && write1h > 0) out.cacheWrite1hTokens = write1h;
  if (write5m != null && write5m > 0) out.cacheWrite5mTokens = write5m;
  // No per-TTL breakdown — use the aggregate cache_creation_input_tokens as 5m
  // (matches computeClaudeUsageCost; avoids overpricing vs the 1h premium rate).
  if (write1h == null && write5m == null) {
    const agg = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
    if (agg > 0) out.cacheWrite5mTokens = agg;
  }
  const reads = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  if (reads > 0) out.cacheReadTokens = reads;
  return out;
}

/**
 * Price demo usage with the same engine as transcript reports/statusline.
 *
 * Prefer a priced requested router because the router identifies the serving
 * tier. Otherwise use the backend model Claude Code recorded.
 */
export function priceClaudeUsage({ model, resolvedModel = "", usage }) {
  const requested = stripClaudeCodeContextSuffix(String(model || ""));
  const requestedIsPriced = requested
    ? Boolean(lookupFireworksPricing(requested))
    : false;
  // FireRouter delegates to a backend per call, so its own catalog row (if one
  // exists) cannot replace the model that actually served this usage. Stable
  // tier routers are different: their requested id carries the fast/standard
  // tier that a resolved base-model id loses.
  const priceModel = resolvedModel && isFirerouterModelPattern(requested)
    ? resolvedModel
    : (requestedIsPriced ? requested : (resolvedModel || model));
  return priceModel && usage
    ? computeClaudeUsageCost(priceModel, usage)
    : null;
}

/**
 * @typedef {Object} ClaudeRunResult
 * @property {boolean} ok
 * @property {string} text
 * @property {number | null} inputTokens
 * @property {number | null} cacheWrite1hTokens 1h prompt-cache write tokens (billed at a premium)
 * @property {number | null} cacheWrite5mTokens 5m prompt-cache write tokens (billed at a premium)
 * @property {number | null} cacheReadTokens prompt-cache read/hit tokens (billed at a discount)
 * @property {number | null} outputTokens
 * @property {number | null} costUsd Claude Code's own diagnostic total_cost_usd; never used for Fireworks pricing
 * @property {ReturnType<typeof computeClaudeUsageCost> | null} usagePricing canonical provider pricing for the final usage
 * @property {number} seconds
 * @property {{ t: number, text: string }[]} tokenLog
 * @property {string} [error]
 * @property {number} httpStatus
 * @property {string} [errorBody]
 */

/**
 * Spawn a routed `claude -p` headless run and parse its stream-json stdout.
 *
 * @param {{
 *   configDir?: string,
 *   cwd: string,
 *   prompt: string,
 *   signal?: AbortSignal,
 *   onDelta?: (text: string, msSinceStart: number) => void,
 *   onThinking?: (text: string, msSinceStart: number) => void,
 *   onTokens?: (tokens: { inputTokens?: number, outputTokens?: number }) => void,
 *   onError?: (result: ClaudeRunResult) => void,
 *   onStatus?: (label: string) => void,
 *   env?: Record<string, string>,
 *   model?: string,
 *   firstTokenTimeoutMs?: number,
 *   hardCapMs?: number,
 * }} args
 * @returns {Promise<ClaudeRunResult>}
 */
export async function runClaude({
  configDir = "",
  cwd,
  prompt,
  signal,
  onDelta,
  onThinking,
  onTokens,
  onError,
  onStatus,
  onResetOutput,
  env = process.env,
  model = "",
  systemPrompt = "",
  tools = "",
  firstTokenTimeoutMs = FIRST_TOKEN_TIMEOUT_MS,
  hardCapMs = HARD_RUN_CAP_MS,
}) {
  const start = performance.now();
  /** @type {{ t: number, text: string }[]} */
  const tokenLog = [];
  // Token accounting across a possibly-agentic (multi-message) turn: sum input
  // over every message_start, and sum each message's final (cumulative) output
  // at the next message boundary. The `result` event's totals, when present, are
  // authoritative and override the accumulators.
  let sumInput = 0;
  // Anthropic prompt-caching buckets, each billed at a distinct rate.
  let sumCacheWrite1h = 0;
  let sumCacheWrite5m = 0;
  let sumCacheRead = 0;
  let sumOutput = 0;   // banked output of completed messages
  let curOutput = 0;   // cumulative output of the in-flight message
  let resultInput = null;
  let resultCacheWrite1h = null;
  let resultCacheWrite5m = null;
  let resultCacheRead = null;
  let resultCostUsd = null;
  let usagePricing = null;
  let resultOutput = null;
  let text = "";
  let resultText = "";
  // Streaming tool-call arguments: agentic models write the app via the Write
  // tool, so the file body arrives as partial JSON rather than text deltas.
  // Accumulate the fragments and emit the decoded content as it's revealed.
  let toolJson = "";
  let toolEmitted = 0;
  let toolActive = false;
  // The model that actually served the request (from each assistant message).
  // Pricing keys off THIS, never off the requested `--model` alias.
  let resolvedModel = "";
  // Session id from the result event — identifies this run's transcript.
  let sessionId = "";
  let gotResult = false;
  let streamError = "";   // set by an in-stream or result-subtype error event
  let firstDeltaAt = null;
  let stderrTail = "";
  let timedOut = false;

  // Use the user's Nexus-managed Claude profile unless a legacy isolated
  // config dir is passed (tests only).
  const childEnv = configDir
    ? buildIsolatedChildEnv(env, configDir)
    : { ...env };
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  // Pin the incumbent model explicitly (the incumbent's clean settings carries
  // no model). The challenger's settings.json sets its own Fireworks model.
  if (model) {
    args.push("--model", model);
  }
  // Append a quality-bar system prompt to both sides (via --append-system-prompt,
  // which layers on top of Claude Code's default system prompt rather than
  // replacing it) so the race is a fair test of model capability.
  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  // Tools are disabled by default (`--tools ""`). The demo asks for one
  // self-contained HTML file, which needs no tools — and leaving them on is
  // expensive in both time and tokens:
  //   * tool definitions bloat the prompt (glm input 111k -> 49k without them);
  //   * the model burns a turn on TodoWrite before starting;
  //   * it writes the file with Write AND echoes it as text, generating the
  //     whole document twice (opus output 11,995 -> 2,578 tokens).
  // Measured on the same tictactoe prompt: glm-fast 18s -> 10s, opus 135s -> 28s
  // (~4.8x) with cache-write down 120,689 -> 73,539.
  //
  // User MCPs (Google Drive, filesystem servers, etc.) live in ~/.claude.json
  // and are NOT covered by `--tools ""`. `--strict-mcp-config` with no
  // `--mcp-config` keeps the race MCP-free so models cannot invoke mcp__*
  // tools mid-demo.
  args.push("--tools", tools);
  args.push("--strict-mcp-config");
  const child = spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  // First visible phase — the process is up but Claude Code hasn't emitted any
  // stream events yet. Keeps the pane alive from t=0 instead of dead-air.
  onStatus?.("Starting Claude Code…");

  const recordDelta = (delta) => {
    const t = performance.now() - start;
    tokenLog.push({ t, text: delta });
    text += delta;
    onDelta?.(delta, t);
  };

  const recordThinking = (delta) => {
    const t = performance.now() - start;
    onThinking?.(delta, t);
  };

  // File content streamed as Write-tool arguments: show it live, but keep it OUT
  // of `text`. The model usually also echoes the finished file as text_delta, and
  // extractHtml() spans the FIRST doctype to the LAST </html> — so appending both
  // copies would yield a doubled document. `text` therefore holds only real text
  // deltas; when a model writes the file and emits no text at all, finalizeSide's
  // readBestHtmlFromDir(cwd) fallback recovers it from disk.
  const recordToolDelta = (delta) => {
    const t = performance.now() - start;
    tokenLog.push({ t, text: delta });
    onDelta?.(delta, t);
  };

  // Backstops: first-token stall + hard run cap. Cleared on exit.
  let firstTokenTimer = null;
  let hardCapTimer = null;
  const clearTimers = () => {
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    if (hardCapTimer) clearTimeout(hardCapTimer);
    firstTokenTimer = hardCapTimer = null;
  };
  // The first-token watchdog only fires during the pre-text warm-up. Agentic
  // runs can spend a long time thinking / running tools before the first
  // text_delta, so reset it on any progress signal (status phase, thinking
  // delta, tool-use start) — a true stall is NO activity for the whole window.
  // The hard cap (hardCapMs) still bounds the whole run regardless.
  const resetFirstTokenTimer = () => {
    if (!firstTokenTimer || timedOut || gotResult || firstDeltaAt) return;
    clearTimeout(firstTokenTimer);
    firstTokenTimer = setTimeout(() => {
      if (!firstDeltaAt && !gotResult && !timedOut) {
        timedOut = true;
        child.kill("SIGTERM");
      }
    }, firstTokenTimeoutMs);
  };
  firstTokenTimer = setTimeout(() => {
    if (!firstDeltaAt && !gotResult && !timedOut) {
      timedOut = true;
      child.kill("SIGTERM");
    }
  }, firstTokenTimeoutMs);
  hardCapTimer = setTimeout(() => {
    // Don't kill a child that already produced a result event — it's just
    // finishing its shutdown flush, and killing it would flip a successful run
    // to failed despite complete output + usage.
    if (!timedOut && !gotResult) {
      timedOut = true;
      child.kill("SIGTERM");
    }
  }, hardCapMs);

  // Parent abort (Ctrl-C) → kill the child.
  const onParentAbort = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  if (signal) {
    if (signal.aborted) onParentAbort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // non-JSON line (banner/etc.) — ignore
    }
    const parsed = parseStreamJson(obj);
    // ANY event proves the stream is alive. The first-token watchdog exists to
    // catch a DEAD connection, not a slow model — so reset it here rather than
    // only on events that happen to carry a status string. Opus streams
    // `signature_delta` events during encrypted reasoning; those match none of
    // the status-setting branches, so a long think emitted no status, the timer
    // ran out, we SIGTERMed the model, and Claude Code reported the kill back as
    // "error_during_execution · terminal aborted_streaming".
    resetFirstTokenTimer();
    if (parsed.error) {
      // An in-stream error event OR a `result` event with subtype error. Don't
      // treat the run as successful just because a result event arrived.
      streamError = parsed.error;
    }
    // ...but a transient error that Claude Code retries past, or that is followed
    // by a successful result event, must NOT fail the run. streamError used to be
    // sticky: one 529 mid-stream sank a race that actually completed fine.
    if (parsed.apiRetry) {
      streamError = "";
    }
    if (parsed.isResult && !parsed.error) {
      // Claude Code reported the run finished without error — authoritative.
      streamError = "";
    }
    if (parsed.resolvedModel) {
      resolvedModel = parsed.resolvedModel;
    }
    if (parsed.status) {
      onStatus?.(parsed.status);
    }
    if (parsed.thinkingDeltas && parsed.thinkingDeltas.length > 0) {
      for (const d of parsed.thinkingDeltas) recordThinking(d);
    }
    if (parsed.deltas && parsed.deltas.length > 0) {
      for (const d of parsed.deltas) recordDelta(d);
      if (!firstDeltaAt) firstDeltaAt = performance.now();
    }
    // Tool-call arguments stream as partial JSON. When the model writes the app
    // with the Write tool (rather than emitting it as text), the file body lives
    // here — decode and emit it so the pane shows the code as it appears.
    if (parsed.toolUseStart) {
      toolJson = "";
      toolEmitted = 0;
      // Only stream file-writing tools; see FILE_WRITING_TOOLS.
      toolActive = FILE_WRITING_TOOLS.has(parsed.toolUseStart.name);
    }
    if (parsed.contentBlockStop) {
      toolActive = false;
    }
    // The model typically writes the file with a tool AND then echoes it as
    // text. Both go to the pane, so without this the pane tail rewinds through a
    // second doctype. Clear the pane once when that echo starts so the viewer
    // sees a single copy.
    if (parsed.textBlockStart && toolEmitted > 0) {
      toolEmitted = 0;
      onResetOutput?.();
    }
    if (toolActive && typeof parsed.toolInputJson === "string") {
      toolJson += parsed.toolInputJson;
      const revealed = toolFileContentSoFar(toolJson);
      if (revealed.length > toolEmitted) {
        recordToolDelta(revealed.slice(toolEmitted));
        toolEmitted = revealed.length;
        if (!firstDeltaAt) firstDeltaAt = performance.now();
      }
    }
    if (parsed.isResult) {
      gotResult = true;
      if (parsed.result) resultText = parsed.result;
      if (typeof parsed.inputTokens === "number") resultInput = parsed.inputTokens;
      if (typeof parsed.cacheWrite1hTokens === "number") resultCacheWrite1h = parsed.cacheWrite1hTokens;
      if (typeof parsed.cacheWrite5mTokens === "number") resultCacheWrite5m = parsed.cacheWrite5mTokens;
      if (typeof parsed.cacheReadTokens === "number") resultCacheRead = parsed.cacheReadTokens;
      if (typeof parsed.outputTokens === "number") resultOutput = parsed.outputTokens;
      if (typeof parsed.costUsd === "number") resultCostUsd = parsed.costUsd;
      if (parsed.sessionId) sessionId = parsed.sessionId;
      // Cost via the shared computeClaudeUsageCost (the same function
      // `claude usage`/`claude live` use on session data) — correct cache
      // write/read bucketing plus geo/batch/web-search handling.
      //
      // Choosing the price key is subtle, because the two candidates carry
      // different information:
      //   * the REQUESTED id is the router, which is what determines the serving
      //     TIER and therefore the rate (glm-fast-latest = $2.10/$6.60 fast,
      //     glm-latest = $1.40/$4.40 standard);
      //   * the RESOLVED id from the assistant messages is the BASE MODEL, which
      //     identifies the family but NOT the tier — glm-fast-latest, glm-latest
      //     and glm-5p2-fast all report accounts/fireworks/models/glm-5p2.
      // So prefer the requested id whenever it has its own Fireworks price, or a
      // fast router silently gets billed at standard rates. Only fall back to
      // the resolved model when the request was an opaque router with no price
      // of its own (firerouter), where the backend it picked is the only key.
      usagePricing = priceClaudeUsage({ model, resolvedModel, usage: parsed.usage });
      // The result event's totals are authoritative — surface them to the live
      // meter so the cost reflects real usage as soon as the run finishes.
      onTokens?.({
        inputTokens: resultInput ?? undefined,
        cacheWrite1hTokens: resultCacheWrite1h ?? undefined,
        cacheWrite5mTokens: resultCacheWrite5m ?? undefined,
        cacheReadTokens: resultCacheRead ?? undefined,
        outputTokens: resultOutput ?? undefined,
      });
    } else if (parsed.messageStart) {
      sumOutput += curOutput;
      curOutput = 0;
      if (typeof parsed.inputTokens === "number") {
        sumInput += parsed.inputTokens;
      }
      if (typeof parsed.cacheWrite1hTokens === "number") {
        sumCacheWrite1h += parsed.cacheWrite1hTokens;
      }
      if (typeof parsed.cacheWrite5mTokens === "number") {
        sumCacheWrite5m += parsed.cacheWrite5mTokens;
      }
      if (typeof parsed.cacheReadTokens === "number") {
        sumCacheRead += parsed.cacheReadTokens;
      }
      onTokens?.({
        inputTokens: sumInput || undefined,
        cacheWrite1hTokens: sumCacheWrite1h || undefined,
        cacheWrite5mTokens: sumCacheWrite5m || undefined,
        cacheReadTokens: sumCacheRead || undefined,
        outputTokens: sumOutput + curOutput,
      });
    } else if (typeof parsed.outputTokens === "number") {
      curOutput = parsed.outputTokens;
      onTokens?.({ inputTokens: sumInput || undefined, outputTokens: sumOutput + curOutput });
    }
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
    // Keep only the tail so a chatty stderr doesn't grow unbounded.
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });

  const exitCode = await new Promise((resolve) => {
    child.on("error", (e) => {
      // spawn ENOENT — claude not on PATH.
      stderrBuf += `\n${e.message}`;
      resolve(-1);
    });
    child.on("close", (code) => resolve(code));
  });

  clearTimers();
  if (signal) signal.removeEventListener("abort", onParentAbort);
  stderrTail = stderrBuf.trim();

  const seconds = (performance.now() - start) / 1000;

  // Resolve final token counts: the result event's totals are authoritative;
  // otherwise fall back to the per-message accumulators.
  const accOutput = sumOutput + curOutput;
  const inputTokens = resultInput ?? (sumInput || null);
  const cacheWrite1hTokens = resultCacheWrite1h ?? (sumCacheWrite1h || null);
  const cacheWrite5mTokens = resultCacheWrite5m ?? (sumCacheWrite5m || null);
  const cacheReadTokens = resultCacheRead ?? (sumCacheRead || null);
  const outputTokens = resultOutput ?? (accOutput || null);
  // Keep Claude Code's own total for diagnostics only. It prices Fireworks
  // models from Anthropic tables and must never drive the demo comparison.
  const costUsd = resultCostUsd;
  // Older event streams can omit the result-level usage object while still
  // carrying per-message token totals. Price that aggregate through the same
  // canonical engine rather than duplicating rate math in the demo.
  if (!usagePricing && [
    inputTokens,
    cacheWrite1hTokens,
    cacheWrite5mTokens,
    cacheReadTokens,
    outputTokens,
  ].some((value) => value != null)) {
    usagePricing = priceClaudeUsage({
      model,
      resolvedModel,
      usage: {
        input_tokens: inputTokens ?? 0,
        cache_creation: {
          ephemeral_1h_input_tokens: cacheWrite1hTokens ?? 0,
          ephemeral_5m_input_tokens: cacheWrite5mTokens ?? 0,
        },
        cache_read_input_tokens: cacheReadTokens ?? 0,
        output_tokens: outputTokens ?? 0,
      },
    });
  }

  if (timedOut && !gotResult) {
    const which = firstDeltaAt ? "run cap" : "first token";
    const limitMs = firstDeltaAt ? hardCapMs : firstTokenTimeoutMs;
    const stalled = firstDeltaAt
      ? `run cap reached after ${Math.round(limitMs / 1000)}s — runaway agentic loop.`
      : `no tokens after ${Math.round(limitMs / 1000)}s — connection stalled or no content deltas.`;
    const msg = `claude timed out (${which}) ${stalled}`;
    const result = {
      ok: false, text, inputTokens, cacheWrite1hTokens, cacheWrite5mTokens, cacheReadTokens, outputTokens, costUsd, usagePricing, resolvedModel, sessionId, seconds, tokenLog,
      error: msg, httpStatus: 0, errorBody: stderrTail,
    };
    onError?.(result);
    return result;
  }

  // An in-stream / result-subtype error event means the run failed even if the
  // process exited 0 with a result event — surface it instead of claiming ok.
  if (streamError) {
    const result = {
      ok: false, text, inputTokens, cacheWrite1hTokens, cacheWrite5mTokens, cacheReadTokens, outputTokens, costUsd, usagePricing, resolvedModel, sessionId, seconds, tokenLog,
      error: streamError, httpStatus: 0, errorBody: stderrTail || streamError,
    };
    onError?.(result);
    return result;
  }

  if (gotResult && exitCode === 0) {
    return {
      ok: true,
      text: text || resultText,
      inputTokens,
      cacheWrite1hTokens,
      cacheWrite5mTokens,
      cacheReadTokens,
      outputTokens,
      costUsd,
      usagePricing,
      resolvedModel,
      sessionId,
      seconds,
      tokenLog,
      httpStatus: 200,
    };
  }

  const error = stderrTail
    || `claude exited ${exitCode} with no result${gotResult ? " (result event received but non-zero exit)" : ""}`;
  const result = {
    ok: false, text, inputTokens, cacheWrite1hTokens, cacheWrite5mTokens, cacheReadTokens, outputTokens, costUsd, seconds, tokenLog,
    error, httpStatus: 0, errorBody: stderrTail,
  };
  onError?.(result);
  return result;
}
