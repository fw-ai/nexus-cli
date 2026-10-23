/**
 * Raw-ANSI split-pane TUI for `nexus demo` (§4 of the brief).
 *
 * Zero dependencies: hand-rolled cursor positioning + per-row clear, drawing two
 * equal columns with a vertical divider. Each column has a static header, a
 * tail-following stream body, a progress bar, and a live meter footer.
 *
 * Mode-agnostic: the orchestrator drives `pushDelta(side, text)` at whatever
 * cadence it likes — replay schedules deltas by their recorded timestamps, race
 * forwards live deltas as they arrive. The renderer's own wall-clock since
 * `start()` is the elapsed time, which in replay matches the recorded timing.
 *
 * Degrades to a stacked (vertical) layout under 80 columns. Non-TTY handling is
 * the orchestrator's job (it skips the TUI entirely and uses --json).
 */

import process from "node:process";
import { performance } from "node:perf_hooks";
import {
  ACCENT, BOLD, DIM, PRIMARY, RED, YELLOW, RESET, HIDE_CURSOR, SHOW_CURSOR,
  HOME_CURSOR, moveTo, CLEAR_LINE, truncateVisible, padRight, progressBar,
  stripAnsi, visibleWidth,
} from "./ansi.mjs";
import { formatSeconds, formatUsd, formatTokens } from "./measurement.mjs";

const MIN_COLS_FOR_SPLIT = 80;
const RENDER_INTERVAL_MS = 100; // 10Hz meter updates
// Braille spinner for the "warming up" state and the race banner. Animated on
// wall-clock so a side visibly ticks even before its first token arrives —
// proof that it's running, not stalled.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// A shared race banner (title + rule) sits above both panes so a single clock
// spans the two columns — the clearest signal that they started together.
const HEADER_ROWS = 2;

/** @returns {boolean} */
export function isTtyCapable() {
  return Boolean(process.stdout.isTTY) && (process.stdout.columns ?? 0) >= 40;
}

/**
 * @typedef {Object} SideHeader
 * @property {string} provider
 * @property {string} model
 * @property {string} costLabel  "list price" | "serverless"
 * @property {{ inputPerMillion: number | null, outputPerMillion: number | null, cacheWrite1hPerMillion: number | null, cacheWrite5mPerMillion: number | null, cacheReadPerMillion: number | null }} rates
 */

/**
 * @typedef {Object} SideFinal
 * @property {boolean} ok
 * @property {number | null} inputTokens
 * @property {number | null} cacheWrite1hTokens
 * @property {number | null} cacheWrite5mTokens
 * @property {number | null} cacheReadTokens
 * @property {number | null} outputTokens
 * @property {number} seconds
 * @property {number} cost
 * @property {string} [error]
 */

export class SplitPaneRenderer {
  /**
   * @param {{
   *   incumbent: SideHeader,
   *   fireworks: SideHeader,
   *   mode?: "race" | "replay",
   *   stdout?: NodeJS.WriteStream,
   *   totalDeltas?: { incumbent?: number, fireworks?: number },
   * }} opts
   */
  constructor({ incumbent, fireworks, mode = "replay", stdout = process.stdout, totalDeltas = {} }) {
    this.stdout = stdout;
    this.mode = mode;
    this.cols = stdout.columns || 80;
    this.rows = stdout.rows || 24;
    this.stacked = this.cols < MIN_COLS_FOR_SPLIT;
    this.totalDeltas = totalDeltas;

    this.sides = {
      incumbent: makeSide(incumbent),
      fireworks: makeSide(fireworks),
    };
    this.startTime = 0;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.startTime = performance.now();
    this.stdout.write(HIDE_CURSOR);
    this.render();
    this.timer = setInterval(() => this.render(), RENDER_INTERVAL_MS);
    // Redrawing is never a reason to keep the process alive — the race is. An
    // unref'd timer means a renderer that is never stopped (a thrown error
    // between start() and stop()) surfaces that error instead of hanging.
    this.timer.unref?.();
  }

  /** @param {"incumbent" | "fireworks"} side @param {string} text */
  pushThinking(side, text) {
    const s = this.sides[side];
    if (!s || s.done || !text) {
      return;
    }
    s.thinkingBuffer += text;
    if (s.thinkingBuffer.length > 200_000) {
      s.thinkingBuffer = s.thinkingBuffer.slice(-100_000);
    }
  }

  /**
   * Drop the streamed output buffer for a side. Used when a model writes the
   * file with a tool and then echoes the same file as text: without this the
   * pane would show the document twice.
   * @param {"incumbent" | "fireworks"} side
   */
  resetOutput(side) {
    const s = this.sides[side];
    if (!s || s.done) {
      return;
    }
    s.buffer = "";
    s.chars = 0;
  }

  /** @param {"incumbent" | "fireworks"} side @param {string} text */
  pushDelta(side, text) {
    const s = this.sides[side];
    if (!s || s.done) {
      return;
    }
    // Stamp the first token's arrival (relative to the shared t=0) so the pane
    // can report an "active generation" clock separate from total wall-clock.
    if (s.firstDeltaMs == null) {
      s.firstDeltaMs = performance.now() - this.startTime;
    }
    s.chars += text.length;
    s.deltasEmitted += 1;
    s.buffer += text;
    // Keep the buffer bounded; we only ever show the last N lines.
    if (s.buffer.length > 200_000) {
      s.buffer = s.buffer.slice(-100_000);
    }
  }

  /**
   * Update a side's pre-first-token phase label (e.g. "Claude Code ready",
   * "Thinking…", "Running Write…"). Shown in the pane body while we wait on the
   * first text delta, so a slow-to-stream side reads as actively working rather
   * than stalled. Ignored once the side has finished.
   * @param {"incumbent" | "fireworks"} side @param {string} text
   */
  setStatus(side, text) {
    const s = this.sides[side];
    if (!s || s.done || !text) {
      return;
    }
    s.status = text;
  }

  /**
   * Freeze a side's clock at the instant its own run ends — call this the moment
   * that side's runner resolves, NOT after both sides finish. Without it, the
   * faster side keeps ticking (and the header keeps racing) until the slower side
   * ends, so a finished pane reads as "still working" and both panes end up
   * frozen at the same race-total, hiding the speed gap. Token/cost numbers are
   * reconciled later by {@link finish}; the clock captured here is preserved.
   *
   * `ok` is the runner's outcome (known at resolve time) so the bar flips to the
   * full ▓ "done ✓" / "failed ✗" state immediately at freeze, instead of showing
   * the indeterminate sweep while finalizeBoth reconciles tokens/cost.
   * @param {"incumbent" | "fireworks"} side
   * @param {boolean} ok
   */
  freeze(side, ok) {
    const s = this.sides[side];
    if (!s) {
      return;
    }
    this.freezeClock(s);
    s.done = true;
    s.ok = Boolean(ok);
    this.render();
  }

  /**
   * Update a side's token counts mid-stream (from the runner's usage events) so
   * the live meter shows real input/output tokens and cost as they're reported,
   * not a chars/4 estimate. The Fireworks side's cost is input-dominated, so
   * this is what makes its running cost actually move.
   * @param {"incumbent" | "fireworks"} side
   * @param {{ inputTokens?: number, cacheWrite1hTokens?: number, cacheWrite5mTokens?: number, cacheReadTokens?: number, outputTokens?: number }} tokens
   */
  setTokens(side, tokens) {
    const s = this.sides[side];
    if (!s) {
      return;
    }
    if (typeof tokens.inputTokens === "number") s.inputTokens = tokens.inputTokens;
    if (typeof tokens.cacheWrite1hTokens === "number") s.cacheWrite1hTokens = tokens.cacheWrite1hTokens;
    if (typeof tokens.cacheWrite5mTokens === "number") s.cacheWrite5mTokens = tokens.cacheWrite5mTokens;
    if (typeof tokens.cacheReadTokens === "number") s.cacheReadTokens = tokens.cacheReadTokens;
    if (typeof tokens.outputTokens === "number") s.outputTokens = tokens.outputTokens;
  }

  /** Idempotent: capture the elapsed clock once, at the first freeze/finish. */
  freezeClock(s) {
    if (s.frozenMs === 0) {
      s.frozenMs = performance.now() - this.startTime;
    }
  }

  /** @param {"incumbent" | "fireworks"} side @param {SideFinal} final */
  finish(side, final) {
    const s = this.sides[side];
    if (!s) {
      return;
    }
    s.done = true;
    s.ok = final.ok;
    s.error = final.error;
    // Preserve an earlier freeze() (the real per-side finish time); only capture
    // now if this side was never frozen (e.g. the non-race / direct-finish path).
    this.freezeClock(s);
    s.inputTokens = final.inputTokens;
    s.cacheWrite1hTokens = final.cacheWrite1hTokens;
    s.cacheWrite5mTokens = final.cacheWrite5mTokens;
    s.cacheReadTokens = final.cacheReadTokens;
    s.outputTokens = final.outputTokens;
    s.cost = final.cost;
    s.costFinalized = true;
    s.seconds = final.seconds;
    this.render();
  }

  stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Park the cursor below the rendered area and restore it.
    const totalRows = this.totalRows();
    this.stdout.write(`${moveTo(totalRows + 1, 1)}\n${SHOW_CURSOR}`);
  }

  // ── layout ────────────────────────────────────────────────────────────────

  totalRows() {
    const bodyRows = this.bodyRows();
    const body = this.stacked
      ? (bodyRows + 6) * 2 + 1 // two stacked blocks + a separator
      : bodyRows + 6;
    return body + HEADER_ROWS;
  }

  bodyRows() {
    // -10 (not -8) leaves room for the two shared-header rows above the panes.
    const budget = Math.max(8, this.rows - 10);
    return Math.max(6, Math.min(40, budget));
  }

  render() {
    if (this.stopped) {
      return;
    }
    const body = this.stacked ? this.stackedLines() : this.splitLines();
    const lines = [...this.headerLines(this.cols), ...body];
    let out = HOME_CURSOR;
    for (let i = 0; i < lines.length; i += 1) {
      out += `${moveTo(i + 1, 1)}${lines[i]}${CLEAR_LINE}`;
    }
    this.stdout.write(out);
  }

  /**
   * The shared race banner: one clock and one status spanning both columns.
   * A single timeline above both panes is the strongest signal that the two
   * models launched together and are timed head-to-head — the point being that
   * they run *at the same time*, even while one is still warming up and only the
   * other is streaming text.
   * @param {number} width
   * @returns {string[]}
   */
  headerLines(width) {
    const inc = this.sides.incumbent;
    const fw = this.sides.fireworks;
    const bothDone = inc.done && fw.done;
    const nowMs = performance.now() - this.startTime;
    // Frozen at the last finish once both are done; live wall-clock otherwise.
    const clockMs = bothDone ? Math.max(inc.frozenMs, fw.frozenMs) : nowMs;
    const clock = formatSeconds(clockMs / 1000);

    let tag;
    let subtitle;
    if (bothDone) {
      tag = `${BOLD}${PRIMARY}✓ RACE COMPLETE${RESET}`;
      subtitle = "both models finished";
    } else if (inc.done || fw.done) {
      const finished = (inc.done ? inc : fw).header.provider;
      const running = (inc.done ? fw : inc).header.provider;
      tag = `${BOLD}${YELLOW}⚡ RACING${RESET}`;
      subtitle = `${finished} finished · ${running} still running`;
    } else {
      const spin = SPINNER[Math.floor(nowMs / 80) % SPINNER.length];
      tag = `${BOLD}${YELLOW}${spin} RACING${RESET}`;
      subtitle = "both models running at the same time";
    }
    const line = ` ${tag}  ${DIM}${subtitle}${RESET}   ⏱ ${clock} ${DIM}total${RESET}`;
    const rule = `${DIM}${"─".repeat(Math.max(0, width))}${RESET}`;
    return [truncateVisible(line, width), rule];
  }

  splitLines() {
    const sideWidth = Math.floor((this.cols - 1) / 2);
    const bodyRows = this.bodyRows();
    const left = this.sideLines(this.sides.incumbent, sideWidth, bodyRows, "incumbent");
    const right = this.sideLines(this.sides.fireworks, sideWidth, bodyRows, "fireworks");
    const lines = [];
    for (let i = 0; i < left.length; i += 1) {
      const l = padRight(left[i], sideWidth);
      const r = padRight(right[i], sideWidth);
      lines.push(`${l}${DIM}│${RESET}${r}`);
    }
    return lines;
  }

  stackedLines() {
    const width = this.cols;
    const bodyRows = Math.max(4, Math.floor(this.bodyRows() / 2));
    const left = this.sideLines(this.sides.incumbent, width, bodyRows, "incumbent");
    const right = this.sideLines(this.sides.fireworks, width, bodyRows, "fireworks");
    const sep = `${DIM}${"─".repeat(width)}${RESET}`;
    return [...left, sep, ...right];
  }

  /**
   * @param {SideState} s
   * @param {number} width
   * @param {number} bodyRows
   * @param {"incumbent"|"fireworks"} [side]
   * @returns {string[]}
   */
  sideLines(s, width, bodyRows, side = "incumbent") {
    const now = performance.now() - this.startTime;
    const elapsedMs = s.done ? s.frozenMs : now;
    const elapsedSec = elapsedMs / 1000;

    // Token accounting: prefer REAL usage when the runner reports a non-zero
    // count (mid-stream via setTokens, or reconciled at finish). Fall back to a
    // chars/4 estimate when the reported count is 0/null — some backends (the
    // Fireworks challenger via Claude Code) report 0 in the mid-stream usage
    // events and only surface real totals in the result event, so using 0
    // verbatim would pin the live meter at "$0" instead of ticking up with
    // streamed output.
    const tokens = (s.outputTokens != null && s.outputTokens > 0)
      ? s.outputTokens
      : Math.floor(s.chars / 4);

    // cost: real usage when done, else running estimate using real tokens if reported
    const inRate = s.header.rates.inputPerMillion;
    const outRate = s.header.rates.outputPerMillion;
    const cacheWrite1hRate = s.header.rates.cacheWrite1hPerMillion ?? 0;
    const cacheWrite5mRate = s.header.rates.cacheWrite5mPerMillion ?? 0;
    const cacheReadRate = s.header.rates.cacheReadPerMillion ?? 0;
    let cost;
    const estIn = (s.inputTokens != null && s.inputTokens > 0)
      ? s.inputTokens
      : (Math.floor((s.header.promptChars ?? 0) / 4) || 0);
    // Cache tokens are only known once the result event arrives (also when
    // costFinalized flips), so the mid-stream estimate uses 0 for them until
    // then — same as outputTokens falling back to chars/4. After finish, the
    // canonical provider-priced cost is used, so the estimate never needs to
    // guess cache tokens before they're reported.
    const estCacheWrite1h = s.cacheWrite1hTokens ?? 0;
    const estCacheWrite5m = s.cacheWrite5mTokens ?? 0;
    const estCacheRead = s.cacheReadTokens ?? 0;
    if (s.costFinalized) {
      cost = s.cost;
    } else if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) {
      // A delegating router has no honest pre-run rate. Wait for the result's
      // resolved backend model rather than drawing a proxy dollar amount.
      cost = null;
    } else {
      // Keep estimating through freeze() — done is set when the runner resolves,
      // but finish() (reconciled cost) only runs after finalizeBoth().
      cost = (estIn / 1e6) * inRate
        + (estCacheWrite1h / 1e6) * cacheWrite1hRate
        + (estCacheWrite5m / 1e6) * cacheWrite5mRate
        + (estCacheRead / 1e6) * cacheReadRate
        + (tokens / 1e6) * outRate;
    }

    const lines = [];
    // header (2 lines). Pair BOLD with an explicit color so it never renders as
    // bare bright-default (white-on-white on light themes); the color also
    // distinguishes the two sides at a glance.
    const headColor = side === "fireworks" ? PRIMARY : ACCENT;
    // Model is the headline (this is a model-vs-model comparison);
    // the provider is a dim secondary line, not the framing.
    lines.push(` ${BOLD}${headColor}${truncateVisible(s.header.model, width - 1)}${RESET}`);
    const modelLine = ` ${DIM}${truncateVisible(s.header.provider, width - 1)}${RESET}`;
    lines.push(padRight(modelLine, width));
    // divider
    lines.push(`${DIM} ${"─".repeat(Math.max(0, width - 2))}${RESET}`);
    // body. A failed side's error is rendered here directly — NOT via pushDelta,
    // because pushDelta increments s.chars and the meter would then count the
    // error text as ~len/4 phantom output tokens. Keeping error text out of
    // s.buffer/chars is what makes a failed side read "0 tok / failed ✗"
    // instead of "58 tok" off the error string length.
    const failed = s.ok === false && s.error;
    // Before the first delta, the stream body is empty — which reads as "nothing
    // is happening," and (worse) as if this side hasn't started while the other
    // is already streaming. Instead of a static placeholder, show a live warm-up
    // panel: a spinner, the current phase (Claude Code init → thinking → running
    // tools, fed by setStatus), and this side's OWN elapsed clock. The ticking
    // clock proves it started at the same t=0 as the other side; the phase proves
    // it's actively working, not stalled.
    const waiting = !s.done && !s.buffer && !s.thinkingBuffer;
    if (waiting) {
      const spin = SPINNER[Math.floor(now / 80) % SPINNER.length];
      const phase = s.status || "waiting for first token…";
      const clk = formatSeconds(elapsedSec);
      lines.push(` ${headColor}${spin}${RESET} ${truncateVisible(phase, Math.max(1, width - 12))}  ${DIM}${clk}${RESET}`);
      for (let i = 1; i < bodyRows; i += 1) {
        lines.push("");
      }
    } else {
      const body = failed ? hardWrap(s.error, width) : paneBodyLines(s, bodyRows);
      for (let i = 0; i < bodyRows; i += 1) {
        const line = body[i] ?? "";
        if (failed) {
          lines.push(` ${RED}${truncateVisible(line, width - 2)}${RESET}`);
        } else if (line.thinking) {
          lines.push(` ${DIM}${truncateVisible(line.text, width - 2)}${RESET}`);
        } else {
          lines.push(` ${truncateVisible(line.text, width - 2)}`);
        }
      }
    }
    // progress / done
    lines.push(this.barLine(s, width));
    // meter (2 lines). Two clocks: "total" is wall-clock since the shared t=0;
    // "gen" is the active generation time — first token to done. The gap between
    // them is time-to-first-token (warm-up), during which the total ticks but
    // nothing is being produced. A lone total clock therefore reads as "still
    // working" even while the model is only spinning up; showing gen separately
    // makes the honest "actually generating" time legible.
    const activeMs = s.firstDeltaMs == null ? 0 : Math.max(0, elapsedMs - s.firstDeltaMs);
    lines.push(
      ` ⏱ ${formatSeconds(elapsedSec)} ${DIM}total${RESET}`
      + `  ${YELLOW}⚡${RESET} ${formatSeconds(activeMs / 1000)} ${DIM}gen${RESET}`,
    );
    const tokStr = s.done && s.outputTokens == null ? "—" : formatTokens(tokens);
    const costStr = cost > 0 || s.done ? formatUsd(cost) : "—";
    // Only call it "measured" once the run is reconciled. Mid-stream the figure
    // is real money already incurred (Anthropic reports the whole cache write on
    // message_start, so a 61k-token write shows ~$0.61 before any output) but it
    // is NOT the final total — output is still accruing. Labelling that
    // "measured" reads as a finished number for a run that is still going.
    const costLabel = s.costFinalized ? s.header.costLabel : "so far";
    lines.push(
      ` ↑ ${tokStr} tok  ${costStr} ${DIM}${costLabel}${RESET}`,
    );
    return lines;
  }

  /** @param {SideState} s @param {number} width */
  barLine(s, width) {
    const inner = Math.max(0, width - 12);
    // Only show the ✓/✗ outcome once finish() has reconciled ok. Before that
    // (side frozen but finalizeBoth still running), fall through to the
    // progress/indeterminate bar so a successful side doesn't flash "failed ✗".
    if (s.ok === true) {
      return ` ${progressBar(1, 1, inner)}  ${PRIMARY}done ✓${RESET}`;
    }
    if (s.ok === false) {
      return ` ${progressBar(0, 1, inner)}  ${RED}failed ✗${RESET}`;
    }
    if (s.error) {
      return ` ${RED}${truncateVisible(s.error, width - 2)}${RESET}`;
    }
    const total = this.totalDeltas[s === this.sides.incumbent ? "incumbent" : "fireworks"];
    if (total && total > 0) {
      const filled = Math.min(total, s.deltasEmitted);
      return ` ${progressBar(filled, total, inner)}  ${DIM}${Math.round((filled / total) * 100)}%${RESET}`;
    }
    // indeterminate: a small segment sweeping across the bar. Driven by
    // wall-clock, NOT deltasEmitted — before the first token deltasEmitted is 0,
    // so a delta-based position would freeze the segment at the left edge and
    // look dead. Animating on elapsed time keeps the pane visibly alive while
    // we're waiting on time-to-first-token (or stuck).
    const now = performance.now() - this.startTime;
    const segLen = Math.min(6, inner);
    const span = Math.max(1, inner - segLen);
    const pos = Math.floor(now / 120) % span;
    const seg = "▓".repeat(segLen);
    const pad = " ".repeat(pos);
    return ` ${DIM}${pad}${seg}${RESET}`;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Tail of the pane body: reasoning/thinking (dim) above streamed output when both
 * exist, but cap thinking so long traces cannot crowd out live code.
 * @param {SideState} s
 * @param {number} bodyRows
 * @returns {{ text: string, thinking?: boolean }[]}
 */
function paneBodyLines(s, bodyRows) {
  // Phase 1 — reasoning only (no text/output yet): give the whole pane to the
  // thinking trace so the user sees the model's reasoning as it streams.
  if (!s.buffer) {
    const thinkingLines = s.thinkingBuffer ? tailLines(s.thinkingBuffer, bodyRows) : [];
    const lines = thinkingLines.map((text) => ({ text, thinking: true }));
    while (lines.length < bodyRows) {
      lines.push({ text: "" });
    }
    return lines;
  }
  // Phase 2 — code/response has started appearing. Show the code as soon as it
  // arrives by giving it the full pane; the reasoning trace recedes to a single
  // dimmed indicator line so it's acknowledged but no longer eats rows the code
  // needs. The thinking content is preserved in s.thinkingBuffer for the result
  // transcript; only the live pane prioritizes the code once it exists.
  const lines = [];
  if (s.thinkingBuffer) {
    lines.push({ text: "reasoning…", thinking: true });
  }
  const outRows = bodyRows - lines.length;
  for (const text of tailLines(s.buffer, outRows)) {
    lines.push({ text });
  }
  while (lines.length < bodyRows) {
    lines.push({ text: "" });
  }
  return lines;
}

/**
 * @param {SideHeader} header
 * @returns {SideState}
 */
function makeSide(header) {
  return {
    header,
    buffer: "",
    thinkingBuffer: "",
    status: "",
    chars: 0,
    deltasEmitted: 0,
    done: false,
    // Tri-state: null = run resolved (frozen) but outcome not yet reconciled
    // by finish(); true = succeeded; false = failed. freeze() sets done=true
    // without touching ok, so a successful side never flashes "failed ✗" in the
    // window between its runner resolving and finalizeBoth reconciling tokens.
    ok: null,
    error: null,
    firstDeltaMs: null,
    frozenMs: 0,
    inputTokens: null,
    cacheWrite1hTokens: null,
    cacheWrite5mTokens: null,
    cacheReadTokens: null,
    outputTokens: null,
    cost: 0,
    costFinalized: false,
    seconds: 0,
  };
}

/**
 * Last N lines of a (possibly very long) string, without splitting across the
 * whole buffer each call.
 * @param {string} buffer
 * @param {number} n
 * @returns {string[]}
 */
function tailLines(buffer, n) {
  if (!buffer) {
    return [];
  }
  const tail = buffer.length > 50_000 ? buffer.slice(-50_000) : buffer;
  const lines = tail.split("\n");
  return lines.slice(-n);
}

/**
 * Hard-wrap a (possibly long, possibly spaceless) string into width-bound rows.
 * Used for the error body of a failed side — provider error JSON has no spaces
 * to break on, so word-wrap is useless; chunking at the column limit shows the
 * most text. No ANSI awareness needed (error strings are plain text).
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
function hardWrap(text, width) {
  const max = Math.max(1, width - 2);
  const s = String(text);
  if (!s) {
    return [""];
  }
  const lines = [];
  for (let i = 0; i < s.length; i += max) {
    lines.push(s.slice(i, i + max));
  }
  return lines;
}
