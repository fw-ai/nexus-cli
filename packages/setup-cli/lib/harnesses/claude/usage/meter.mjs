/**
 * The live cost meter's screen: a Dashboard that accumulates session-log records
 * into per-turn and per-model tallies, and the tail loop that feeds it.
 *
 * The pieces it is built from live next door, smallest dependency first:
 *   - `meter-style.mjs`  — SGR colours, box glyphs, width measurement
 *   - `meter-layout.mjs` — column widths and value formatting
 *   - `meter-model.mjs`  — pricing, Tally/Turn, log parsing (no rendering)
 *   - `meter-render.mjs` — state in, lines of text out (no accumulation)
 *
 * What stays here is the part that is neither pure formatting nor pure state: the
 * object that watches a log grow and decides what the frame should contain.
 *
 * COST IS NOT COMPUTED HERE — see `meter-model.mjs`.
 */

import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ANSI } from "../../../ui/palette.mjs";
import { sanitize } from "../../../ui/sanitize.mjs";
import { colorEnabled } from "../../../ui/term.mjs";
import {
  COST_COL,
  MODEL_COL,
  tokenHeadings,
  TURN_NO_PREFIX,
} from "./meter-layout.mjs";
import {
  isSettledStopReason,
  labelFor,
  ModelIndex,
  priceCall,
  promptText,
  Tally,
  Turn,
} from "./meter-model.mjs";
import {
  agentPaneWorthShowing,
  renderAgentPane,
  renderBadges,
  renderFooter,
  renderTurnRow,
  rule,
} from "./meter-render.mjs";
import {
  ACCENT,
  applyMeterStyle,
  B,
  BL,
  BR,
  clip,
  COLOR,
  D,
  GHOST,
  H,
  PALETTE,
  R,
  sgr,
  SPIN,
  TL,
  TR,
  V,
  vislen,
} from "./meter-style.mjs";
import { isSyntheticModel } from "./report.mjs";

/** Default footer keys; callers that offer more nav pass their own. */
const DEFAULT_KEY_HINT = "← agents · q quit";

// ── dashboard ────────────────────────────────────────────────────────────────

class Dashboard {
  constructor(filePath, index, {
    fullscreen = true,
    stream = process.stdout,
    agentLabel = "",
    keyHint = DEFAULT_KEY_HINT,
  } = {}) {
    this.path = filePath;
    this.index = index;
    this.stream = stream;
    this.fullscreen = fullscreen && COLOR;
    this.turns = [];
    this.cur = null;
    // message.id -> { turn, priced, weight, bucket }, so a later record for the
    // same call can back out the earlier all-zero payload.
    this.seen = new Map();
    this.totals = new Map();     // bucket key -> Tally, insertion-ordered
    this.colors = new Map();
    this.session = filePath ? path.basename(filePath, ".jsonl").slice(0, 8) : "········";
    this.agentLabel = agentLabel;
    this.keyHint = keyHint;
    this.locked = false;
    this.armed = filePath == null;
    this.tick = 0;
    // Live agents pane: a snapshot the caller refreshes, plus which row the
    // pane's own cursor is on and whether the pane has keyboard focus. Null
    // until a caller supplies agents, so a single-log meter draws no pane.
    // Shared object rather than meter-owned state because the keys that move
    // this cursor are read outside the meter — see `agentPane` in usage-live.
    this.agents = null;
    // Sibling-agent spend for the footer's attribution rows, refreshed by the
    // caller: { count, calls, cost }. Null until someone supplies it, so a
    // single-log meter keeps its plain TOTAL row.
    this.peers = null;
  }

  /** Forget the current session — used when following a newer log. */
  reset() {
    this.turns = [];
    this.cur = null;
    this.seen = new Map();
    // Sibling spend describes the session we just dropped, and the next refresh
    // is up to `peersMs` away — leaving it would attribute the old session's
    // subagent cost to the new one for that window. Same for the agents pane:
    // its rows name the previous session's subagents.
    this.peers = null;
    if (this.agents) {
      this.agents.list = [];
      // Drop focus with the rows: an empty pane draws nothing, so leaving it
      // focused would hand the keys to an invisible cursor.
      this.agents.focused = false;
      this.agents.index = 0;
    }
    this.totals = new Map();
    // Also the model index: its `unpriced` set drives the footer's "unpriced
    // (excluded)" line, so a model only the OLD session used would keep being
    // listed against a new session that never saw it. Colours too, so the new
    // session's models are assigned from the top of the palette.
    this.index = new ModelIndex();
    this.colors = new Map();
  }

  color(key) {
    if (!this.colors.has(key)) {
      this.colors.set(key, sgr(PALETTE[this.colors.size % PALETTE.length]));
    }
    return this.colors.get(key);
  }

  feed(rec) {
    if (rec.type === "user") {
      const p = promptText(rec);
      if (p == null) return;
      if (this.cur) this.cur.done = true;
      this.cur = new Turn(this.turns.length + 1, p);
      this.turns.push(this.cur);
      return;
    }
    if (rec.type !== "assistant" || !this.cur) return;
    const msg = rec.message ?? {};
    // Track settledness BEFORE the usage gate: the record that carries
    // `stop_reason: end_turn` is often a content-block record with no usage at
    // all, so gating on usage first means an idle session never registers as
    // settled and the spinner keeps turning.
    if (Object.hasOwn(msg, "stop_reason")) {
      this.cur.settled = isSettledStopReason(msg.stop_reason);
    }
    const u = msg.usage;
    if (!u) return;

    // Sanitized here, at the boundary: the id flows into the badge column, the
    // footer row and the unpriced list, all of which reach the terminal.
    const model = sanitize(msg.model) || "unknown";
    // `<synthetic>` is Claude Code's placeholder for a turn that never reached
    // the API (interrupt, local command). It carries an all-zero payload, so
    // tracking it as a model only buys a phantom footer row, a palette colour
    // and a spurious "unpriced (excluded)" entry.
    if (isSyntheticModel(model)) return;

    // Claude Code writes one record per content block, repeating the SAME
    // message.id — and usage lands on the LAST of them; the earlier blocks are
    // all-zero. Billing is per API call, so keep one entry per id and revise it
    // upward when a richer payload arrives. `||` not `??`: an empty-string id
    // must fall through to the token signature, or every id-less record
    // collapses into a single bucket and the meter under-reports.
    //
    // The token-signature fallback is scoped to the CURRENT TURN. `seen` lives
    // for the whole session, so a global signature made two id-less calls in
    // different turns collide on the same key — and since the tie rule keeps
    // the first, the later call was dropped outright. Two all-zero interrupts
    // counted as one; worse, two genuinely billable calls that happened to
    // match token-for-token silently lost one. Repeated content blocks only
    // ever share a turn, so per-turn scoping still dedupes what it must.
    const key = msg.id
      || `t${this.cur.no}:${[
        u.input_tokens,
        u.cache_read_input_tokens,
        u.cache_creation_input_tokens,
        u.output_tokens,
      ].join(":")}`;
    const priced = priceCall(model, u);
    const weight = priced.input + priced.cacheRead + priced.write5m + priced.write1h + priced.output;
    const prev = this.seen.get(key);
    if (prev) {
      // Ties keep the first record: repeated all-zero blocks shouldn't churn.
      if (weight <= prev.weight) return;
      prev.turn.tally.remove(prev.priced);
      const orphan = this.totals.get(prev.bucket);
      orphan?.remove(prev.priced);
      if (orphan && !orphan.cost && !orphan.input && !orphan.cacheRead
        && !orphan.write5m && !orphan.write1h && !orphan.output) {
        this.totals.delete(prev.bucket);
        const index = prev.turn.models.indexOf(prev.bucket);
        if (index >= 0) prev.turn.models.splice(index, 1);
      }
      prev.turn.tally.add(priced);
      const bucket = this.index.bucket(model, priced);
      if (!this.totals.has(bucket)) this.totals.set(bucket, new Tally());
      this.totals.get(bucket).add(priced);
      if (!prev.turn.models.includes(bucket)) prev.turn.models.push(bucket);
      if (!priced.priced) prev.turn.hasUnpriced = true;
      this.seen.set(key, { ...prev, priced, weight, bucket });
      return;
    }

    this.cur.tally.add(priced);
    this.cur.calls += 1;
    if (!priced.priced) this.cur.hasUnpriced = true;
    const bucket = this.index.bucket(model, priced);
    if (!this.cur.models.includes(bucket)) this.cur.models.push(bucket);
    if (!this.totals.has(bucket)) this.totals.set(bucket, new Tally());
    this.totals.get(bucket).add(priced);
    this.seen.set(key, { turn: this.cur, priced, weight, bucket });
  }

  /**
   * Column header, built from `TOKEN_COLUMNS` so it cannot drift from the rows.
   *
   * The three prompt buckets are DISJOINT and priced differently, which a single
   * `input` heading hid: Anthropic's `input_tokens` counts only the UNCACHED
   * remainder, so a well-cached Opus turn reads `uncached 100 / cached 11.8M` and
   * looks broken until you know that. See `TOKEN_COLUMNS` for where the names come
   * from.
   */
  static HDR = `${TURN_NO_PREFIX}${"model".padEnd(MODEL_COL)}${tokenHeadings()} ${"cost".padStart(COST_COL)}  prompt`;

  /**
   * Bucket-key -> SGR colour, bound so the renderers can ask without holding a
   * reference to the Dashboard.
   */
  get colorOf() {
    return (key) => this.color(key);
  }

  /**
   * Whether the session is waiting on the model right now.
   *
   * Drives the header: a spinner that never stops reads as "still thinking" and
   * makes a finished session look hung, so the spinner is reserved for a turn
   * that has actually not settled.
   */
  get working() {
    return Boolean(this.cur && !this.cur.finished);
  }

  // Rendering lives in `meter-render.mjs`; these pass the state it needs. Kept as
  // methods because tests and the plain-mode writer call them.

  badges(turn) {
    return renderBadges(turn, this.colorOf);
  }

  turnRow(turn, width) {
    return renderTurnRow(turn, { width, tick: this.tick, colorOf: this.colorOf });
  }

  agentPane(width) {
    return renderAgentPane(this.agents, width);
  }

  footer(width) {
    return renderFooter({
      totals: this.totals,
      unpriced: this.index.unpriced,
      peers: this.peers,
      agentLabel: this.agentLabel,
      colorOf: this.colorOf,
      width,
    });
  }

  draw() {
    if (!this.fullscreen) return;
    const cols = this.stream.columns || 100;
    // Never exceed the real pane width: forcing a floor above it wraps every
    // line and destroys the frame. 60 is where the fixed columns themselves
    // stop fitting; below that the rows are truncated but the frame holds.
    const w = Math.min(cols, 132);
    const rows = Math.max(14, this.stream.rows || 24);
    const inner = w - 2;
    const out = [`${ANSI.homeCursor}${ANSI.clearScreen}`];
    const title = clip(Dashboard.TITLE, inner);
    const n = this.turns.length;
    const agentPart = this.agentLabel
      ? `   ·   ${sanitize(this.agentLabel).replace(/\s+/g, " ").trim()}`
      : "";
    // "live" was constant, so it told you the meter was running but never
    // whether anything WAS. Say what the session is doing: spin only while a
    // turn is genuinely unsettled, and name the idle case outright so a finished
    // session doesn't look like it hung mid-request.
    const state = this.working
      ? `${SPIN[this.tick % SPIN.length]} working`
      : (n === 0 ? "idle · no turns yet" : "idle · waiting for your next prompt");
    const meta = clip(
      this.armed
        ? `  ${SPIN[this.tick % SPIN.length]} waiting for first prompt`
        : `  session ${this.session}…${agentPart}   ·   ${n} turn${n === 1 ? "" : "s"}   ·   ${state}`,
      inner,
    );
    out.push(`${ACCENT}${TL}${H.repeat(inner)}${TR}${R}`);
    out.push(`${ACCENT}${V}${R}${B}${title}${R}${" ".repeat(Math.max(0, inner - vislen(title)))}${ACCENT}${V}${R}`);
    out.push(`${ACCENT}${V}${R}${GHOST}${meta}${R}${" ".repeat(Math.max(0, inner - vislen(meta)))}${ACCENT}${V}${R}`);
    out.push(`${ACCENT}${BL}${H.repeat(inner)}${BR}${R}`);
    out.push(`${D}${clip(Dashboard.HDR, w)}${R}`);

    const pane = this.agentPane(w);
    // Rule BETWEEN the pane and the per-model footer, so the agent rows read as
    // their own block instead of running into the cost breakdown. The rule above
    // the pane comes from the turn-table separator below.
    const foot = pane.length
      ? [...pane, rule(w), ...this.footer(w)]
      : this.footer(w);
    if (!this.armed) {
      foot.push(`${GHOST}${clip(`  ${this.keyHint}`, w - 2)}${R}`);
    }
    const avail = Math.max(3, rows - (out.length + foot.length + 3));
    const visible = this.turns.slice(-avail);
    if (this.turns.length > avail) out.push(`${D}  ⋮ (${this.turns.length - avail} earlier turns)${R}`);
    if (this.armed) {
      out.push(GHOST + clip("  send a prompt on the left — the meter will lock onto that session", w - 2) + R);
    }
    for (const t of visible) out.push(this.turnRow(t, w));
    for (let i = out.length + foot.length + 2; i < rows; i += 1) out.push("");
    out.push(rule(w));
    out.push(...foot);
    this.stream.write(out.join("\n"));
  }

  /**
   * Usable width for plain (scrolling) output.
   *
   * Same rule as draw(): never exceed the real terminal, because a fixed width
   * wider than the pane wraps every line. Falls back to 100 when stdout isn't a
   * TTY (piped to a file or a test).
   */
  static plainWidth(stream = process.stdout) {
    return Math.min(stream.columns || 100, 132);
  }

  plainBanner() {
    const w = Dashboard.plainWidth(this.stream) - 2;
    const write = (line) => this.stream.write(`${line}\n`);
    write(`${ACCENT}${TL}${H.repeat(w)}${TR}${R}`);
    const t = Dashboard.TITLE;
    write(`${ACCENT}${V}${R}${B}${t}${R}${" ".repeat(Math.max(0, w - vislen(t)))}${ACCENT}${V}${R}`);
    write(`${ACCENT}${BL}${H.repeat(w)}${BR}${R}`);
    write(`${D}${clip(Dashboard.HDR, Dashboard.plainWidth(this.stream))}${R}`);
  }
}

Dashboard.TITLE = "  ✦  Claude Code · Live Cost Meter  ";



/**
 * Read whole lines appended since `pos`.
 *
 * Returns `[lines, nextPos, truncated]`. A file SHORTER than `pos` was replaced
 * or rewritten, not appended to: keeping the old offset would skip everything
 * written before it and silently lose the head of the new content, so report the
 * truncation and restart from 0.
 */
async function readLines(fd, pos) {
  const { size } = await fd.stat();
  if (size < pos) return [[], 0, true];
  if (size === pos) return [[], pos, false];
  const buf = Buffer.alloc(size - pos);
  await fd.read(buf, 0, buf.length, pos);
  const chunk = buf.toString("utf8");
  const lastNl = chunk.lastIndexOf("\n");
  // A partial trailing line: leave `pos` alone and pick it up next poll.
  if (lastNl === -1) return [[], pos, false];
  return [
    chunk.slice(0, lastNl).split("\n").filter(Boolean),
    pos + Buffer.byteLength(chunk.slice(0, lastNl + 1)),
    false,
  ];
}

// ── tailing a log ────────────────────────────────────────────────────────────

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Replace a pane's agent list, keeping the cursor on the SAME agent.
 *
 * The list grows while you read it — that is the point of a live pane — and
 * subagents are appended, so a positional cursor would stay put while the row
 * under it changed identity. Pressing Enter would then track whatever had
 * shifted into that slot. Re-find the id instead, and only fall back to a
 * clamped position when that agent is genuinely gone.
 *
 * @param {{ list: any[], index: number } | null} pane
 * @param {any[]} agents
 */
export function syncAgentPane(pane, agents) {
  if (!pane || !Array.isArray(agents)) return;
  const prevId = pane.list?.[pane.index]?.id;
  pane.list = agents;
  // Focus cannot outlive the pane being on screen. A subagent log that vanishes
  // (or a session switch, which empties the list) hides the pane while leaving
  // `focused` set — so when the next subagent spawned, the pane silently owned
  // ↑/↓/Enter/Esc without the user ever pressing Tab, and the turn table's keys
  // stopped working for no visible reason.
  if (!agentPaneWorthShowing(agents)) {
    pane.focused = false;
  }
  if (agents.length === 0) {
    pane.index = 0;
    return;
  }
  const found = prevId ? agents.findIndex((a) => a.id === prevId) : -1;
  pane.index = found >= 0
    ? found
    : Math.max(0, Math.min(pane.index | 0, agents.length - 1));
}

/**
 * Tail one session log with the live cost-meter UI.
 *
 * @param {{
 *   filePath: string,
 *   plain?: boolean,
 *   fromStart?: boolean,
 *   follow?: boolean,
 *   pollMs?: number,
 *   stream?: NodeJS.WritableStream,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 *   agentLabel?: string,
 *   readPeers?: () => Promise<{ count: number, calls: number, cost: number } | null>,
 *   peersMs?: number,
 *   agentPane?: { list: any[], index: number, focused: boolean, trackingId: string } | null,
 *   readAgents?: () => Promise<any[]>,
 *   onReady?: (db: Dashboard) => void,
 * }} opts
 */
export async function runUsageMeter({
  filePath,
  plain = false,
  fromStart = true,
  follow = true,
  pollMs = 250,
  stream = process.stdout,
  signal,
  sleep = defaultSleep,
  agentLabel = "",
  readPeers,
  peersMs = 2000,
  keyHint,
  agentPane = null,
  readAgents,
  onReady,
} = {}) {
  if (!filePath) {
    throw new Error("filePath is required");
  }
  // Fullscreen redraw needs colour SGR + cursor addressing. On a TTY with
  // NO_COLOR / TERM=dumb, `Dashboard.fullscreen` would be false and `draw()`
  // would no-op — leaving a blank screen. Fall back to plain scrolling output.
  const colorOn = Boolean(colorEnabled(stream) && !plain);
  applyMeterStyle(colorOn);
  const usePlain = plain || !colorOn;

  const db = new Dashboard(filePath, new ModelIndex(), {
    fullscreen: !usePlain,
    stream,
    agentLabel,
    ...(keyHint ? { keyHint } : {}),
  });
  db.locked = true;
  // Caller-owned so the keys that move the pane cursor (read outside the meter)
  // and the rows the meter draws are the same object — no state to sync.
  if (agentPane && !usePlain) db.agents = agentPane;
  // Let the caller repaint on demand. Without it, a keypress that only moves the
  // pane cursor would not show until the next poll — up to pollMs of apparent
  // dead keyboard. Guarded so a throwing callback can't kill the meter.
  if (typeof onReady === "function") {
    try {
      onReady(db);
    } catch {
      /* a caller that can't take the handle just gets poll-rate repaints */
    }
  }

  if (usePlain) {
    db.plainBanner();
  } else {
    // Alternate screen: the meter repaints the whole frame every poll, and on
    // the normal buffer each of those frames scrolls into history — a few
    // seconds of tailing added ~1000 lines of scrollback and the pane became an
    // endless canvas of stale frames. Here the repaints stay in one screen and
    // exiting restores the shell exactly as it was.
    stream.write(`${ANSI.enterAltScreen}${ANSI.hideCursor}`);
  }

  let restored = false;
  const restore = () => {
    if (restored || usePlain) return;
    restored = true;
    stream.write(`${ANSI.showCursor}${ANSI.exitAltScreen}`);
  };
  // 130 = the conventional "killed by SIGINT" status (128 + SIGINT). The live
  // meter's key watcher exits 130 for a Ctrl+C it reads from stdin, and the
  // terminal delivers BOTH a signal and the 0x03 byte, so exiting 0 here made
  // the status depend on which arrived first.
  const onSigInt = () => {
    restore();
    stream.write("\n");
    process.exit(130);
  };
  process.on("SIGINT", onSigInt);

  // Sibling spend costs one read per subagent log, so refresh it on its own
  // slow cadence instead of every poll, and never let it block the tail loop.
  let peersAt = 0;
  let peersBusy = false;
  const wantAgents = Boolean(agentPane && !usePlain && typeof readAgents === "function");
  // Both the footer split and the agents pane come from the same listing, so
  // they share one cadence and one in-flight guard rather than each re-reading
  // every subagent log on its own timer.
  const refreshPeers = () => {
    if (peersBusy) return;
    if (typeof readPeers !== "function" && !wantAgents) return;
    const now = Date.now();
    if (peersAt && now - peersAt < peersMs) return;
    peersBusy = true;
    peersAt = now;
    Promise.all([
      typeof readPeers === "function"
        ? Promise.resolve().then(() => readPeers()).catch(() => undefined)
        : Promise.resolve(undefined),
      wantAgents
        ? Promise.resolve().then(() => readAgents()).catch(() => undefined)
        : Promise.resolve(undefined),
    ])
      .then(([peers, agents]) => {
        // undefined means that read failed — keep the previous figure rather
        // than blanking a pane because one poll hit a half-written log.
        if (peers !== undefined) db.peers = peers;
        if (Array.isArray(agents)) syncAgentPane(agentPane, agents);
      })
      .catch(() => { /* keep the previous figures */ })
      .finally(() => { peersBusy = false; });
  };

  let fd;
  try {
    fd = await open(filePath, "r");
    let pos = fromStart ? 0 : (await fd.stat()).size;
    let shown = 0;

    // Await once up front so the first frame already carries the split and the
    // agents pane rather than popping them in a beat later.
    if (typeof readPeers === "function" || wantAgents) {
      peersAt = Date.now();
      const [peers, agents] = await Promise.all([
        typeof readPeers === "function"
          ? Promise.resolve().then(() => readPeers()).catch(() => null)
          : Promise.resolve(null),
        wantAgents
          ? Promise.resolve().then(() => readAgents()).catch(() => null)
          : Promise.resolve(null),
      ]);
      db.peers = peers;
      if (Array.isArray(agents)) syncAgentPane(agentPane, agents);
    }

    for (;;) {
      if (signal?.aborted) break;
      refreshPeers();
      const [lines, next, truncated] = await readLines(fd, pos);
      pos = next;
      if (truncated) {
        // The log was rewritten under us. Everything tallied so far describes
        // content that no longer exists, so start the session over rather than
        // mixing old turns with new ones.
        db.reset();
        shown = 0;
      }
      for (const line of lines) {
        try {
          db.feed(JSON.parse(line));
        } catch {
          /* torn write */
        }
      }
      if (usePlain) {
        for (const t of db.turns.slice(shown)) {
          // `finished`, not `done`: the newest turn is settled but not yet
          // superseded, and withholding it prints nothing for completed work.
          if (t.finished || !follow) {
            stream.write(`${db.turnRow(t, Dashboard.plainWidth(stream))}\n`);
            shown += 1;
          }
        }
      } else if (lines.length) {
        db.draw();
      }
      if (!follow) break;
      db.tick += 1;
      if (!usePlain) db.draw();
      await sleep(pollMs);
    }
  } finally {
    if (fd) {
      await fd.close().catch(() => {});
    }
    process.off("SIGINT", onSigInt);
    restore();
    if (usePlain) {
      stream.write("\n");
      for (const ln of db.footer(Dashboard.plainWidth(stream))) {
        stream.write(`${ln}\n`);
      }
    }
  }
  return db;
}

// Re-exported so existing importers (usage-live, usage-agent-picker, tests) keep
// working after the split.
export {
  agentPaneWorthShowing,
  applyMeterStyle,
  Dashboard,
  labelFor,
  ModelIndex,
  priceCall,
  sanitize,
};
