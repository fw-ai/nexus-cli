/**
 * Billing state for the live cost meter: what a call cost, and what a turn is.
 *
 * Nothing here renders anything. COST IS NOT COMPUTED HERE either — every call
 * is priced by `computeClaudeUsageCost`, the same helper behind one-shot
 * `nexus claude usage`, so the live figures and the snapshot cannot
 * disagree.
 */

import { providerListPricing } from "../../../demo/incumbent-detect.mjs";
import { fireworksModelSlug } from "../../../fireworks/model-id.mjs";
import { sanitize } from "../../../ui/sanitize.mjs";
import { computeClaudeUsageCost } from "./pricing.mjs";

// ── pricing one call ─────────────────────────────────────────────────────────

/**
 * Price one API call via the CLI's own cost path.
 *
 * Returns the token split alongside the cost so no renderer has to re-derive the
 * 5m/1h cache-write breakdown — `computeClaudeUsageCost` already does that,
 * including the flat-total fallback for older logs that lack `cache_creation`.
 *
 * `estimated` is the CLI's own "this id matched no known model, here's a
 * reference rate" flag. The meter treats that as unpriced and excludes it: a
 * plausible-looking wrong number during a demo is worse than a visible gap.
 * `cost: null` is the engine saying the same thing outright — it found no rate
 * at all — and is excluded on the same grounds.
 *
 * @param {string} model
 * @param {object} usage
 */
export function priceCall(model, usage) {
  const r = computeClaudeUsageCost(model, usage);
  const unpriced = r.estimated || r.cost == null;
  return {
    cost: unpriced ? 0 : r.cost,
    priced: !unpriced,
    label: labelFor(model, r),
    input: r.input,
    cacheRead: r.cacheRead,
    write5m: r.cacheWrite5m,
    write1h: r.cacheWrite1h,
    output: r.output,
  };
}

/**
 * Display label for a served model id.
 *
 * Anthropic ids get a versioned short name ("Opus 5"), because the CLI's label
 * is family-only ("Claude Opus") and the meter's 8-char column would render
 * Opus 5 and Opus 4.8 identically. Fireworks ids already carry a versioned
 * label ("GLM 5.2"), so those pass through.
 */
export function labelFor(model, priced) {
  if (/claude|opus|sonnet|haiku|fable/i.test(model)) {
    const a = providerListPricing({ provider: "anthropic", modelId: model });
    // Only a concrete list-price row may name the model; the estimated
    // reference row ("Claude Sonnet (reference)") would mislabel an
    // unrecognized id, so those rows read back their own id instead.
    const reference = !a.estimated && a.label ? a.label : model;
    return anthropicLabel(model, priced.rates?.label ?? reference);
  }
  return priced.rates?.label ?? fireworksModelSlug(model) ?? model;
}

/**
 * Compact badge for a turn row: "Opus 5" -> "Opus5", "GLM 5.2" -> "GLM5.2".
 *
 * Keeps the VERSION. Taking only the first word would collapse Opus 5 and
 * Opus 4.8 to the same "Opus" badge, which is the distinction the whole
 * versioned-label path exists to show. Spaces go so a multi-model turn still
 * reads as one token per model ("GLM5.2+Opus5").
 */
export function badgeName(label) {
  return label.replace(/\s+/g, "").slice(0, 8);
}

function anthropicLabel(model, fallback) {
  const bare = model.replace(/\[.*?\]$/, "").replace(/-\d{8}$/, "");
  const m = bare.match(/(opus|sonnet|haiku|fable)-(\d+(?:[-.]\d+)?)/i);
  if (!m) return fallback;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2].replace("-", ".")}`;
}

/**
 * Per-model bookkeeping: which bucket a served id aggregates under, and which
 * ids the CLI could not price. Pricing itself lives in `priceCall`.
 */
export class ModelIndex {
  constructor() {
    this.bucketOf = new Map();   // served id -> footer bucket key
    this.unpriced = new Set();
  }

  /**
   * Record a priced call and return its bucket key. Buckets on the LABEL, so
   * "glm-5p2" and "accounts/fireworks/models/glm-5p2" land in one footer row
   * with one colour rather than two — both forms appear in real logs.
   */
  bucket(model, priced) {
    if (!this.bucketOf.has(model)) {
      this.bucketOf.set(model, priced.priced ? priced.label : model);
      if (!priced.priced) this.unpriced.add(model);
    }
    return this.bucketOf.get(model);
  }
}

// ── accumulating calls ───────────────────────────────────────────────────────

/** Running token and cost totals for a turn, a model, or a whole session. */
export class Tally {
  constructor() {
    this.input = 0;
    this.cacheRead = 0;
    this.write5m = 0;
    this.write1h = 0;
    this.output = 0;
    this.cost = 0;
  }

  /** Accumulate one priced call (the shape `priceCall` returns). */
  add(priced) {
    this.input += priced.input;
    this.cacheRead += priced.cacheRead;
    this.write5m += priced.write5m;
    this.write1h += priced.write1h;
    this.output += priced.output;
    this.cost += priced.cost;
  }

  /**
   * Back out a previously added call.
   *
   * Claude Code repeats a message.id across content-block records and only the
   * last carries real usage, so the live meter counts an early all-zero payload
   * and must revise it when the richer one streams in.
   */
  remove(priced) {
    this.input -= priced.input;
    this.cacheRead -= priced.cacheRead;
    this.write5m -= priced.write5m;
    this.write1h -= priced.write1h;
    this.output -= priced.output;
    this.cost -= priced.cost;
  }

  get cacheWrite() {
    return this.write5m + this.write1h;
  }
}

/** One user prompt and every API call made answering it. */
export class Turn {
  constructor(no, prompt) {
    this.no = no;
    this.prompt = prompt;
    this.tally = new Tally();
    this.models = [];
    this.calls = 0;
    this.done = false;
    // `done` means "a later prompt superseded this turn"; `settled` means "the
    // model stopped talking". They differ for the newest turn, which is settled
    // but not done — without `settled` nothing marks the last turn until the NEXT
    // prompt arrives, which on an idle session never happens, so the meter spins
    // forever after the work is finished.
    this.settled = false;
  }

  /** Nothing more is coming for this turn. */
  get finished() {
    return this.done || this.settled;
  }
}

/**
 * Stop reasons that end a turn.
 *
 * From Anthropic's stop-reason reference. The continuation reasons are the ones
 * NOT listed: `tool_use` (yielding to run a tool) and `pause_turn` (a server-tool
 * loop hit its iteration limit) both mean more calls follow in the same turn.
 */
const SETTLED_STOP_REASONS = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "refusal",
  "model_context_window_exceeded",
]);

/**
 * Whether an assistant record's `stop_reason` means the model is done talking.
 *
 * A missing/null stop_reason is a streaming record that has not landed yet, so
 * it means "still going" — treating unknown as settled would flicker the spinner
 * off mid-turn. An unrecognised value is treated the same way: a future
 * continuation reason should keep the spinner honest rather than claim idle.
 */
export function isSettledStopReason(reason) {
  return typeof reason === "string" && SETTLED_STOP_REASONS.has(reason);
}

// ── reading the log ──────────────────────────────────────────────────────────

/** The user-visible text of a user record, or null if it isn't a real prompt. */
export function promptText(rec) {
  const content = rec.message?.content;
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // A tool_result record is the harness talking to itself, not a new turn.
    if (content.some((b) => b?.type === "tool_result")) return null;
    text = content
      .map((b) => (b?.type === "text" ? b.text : b?.type === "command_name" ? `[cmd:${b.command_name}]` : ""))
      .join(" ");
  } else {
    return null;
  }
  text = sanitize(text);
  text = text.split(/\s+/).filter(Boolean).join(" ");
  if (!text) return null;
  if (/^<(local-command-caveat|command-name|local-command-stdout|command-message|command-args|system-reminder)>/.test(text.trimStart())) {
    return null;
  }
  return text;
}
