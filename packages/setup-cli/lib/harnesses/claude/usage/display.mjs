import process, { stdin, stdout } from "node:process";
import path from "node:path";
import { colorEnabled, bold } from "../../../ui/term.mjs";
import { ANSI, DATA } from "../../../ui/palette.mjs";
import {
  UNPRICED_TEXT,
  addUsage,
  sumUsage,
} from "./cost.mjs";
import { usageCostDigits } from "./format.mjs";

const ANTHROPIC_PRICING_DOCS_URL = "https://platform.claude.com/docs/en/about-claude/pricing";

const RESET = ANSI.reset;
const DIM = ANSI.muted;
const EMPHASIS = ANSI.bold;
const INPUT = DATA.input;
const OUTPUT = DATA.output;
const CLAUDE_MODEL = DATA.claudeModel;
const FIREWORKS_MODEL = DATA.fireworksModel;
const SPEND = DATA.spend;
const ACCENT = ANSI.accent;
const PRIMARY = ANSI.primary;
const SELECTED_BG = ANSI.selectedBg;
const HIDE_CURSOR = ANSI.hideCursor;
const SHOW_CURSOR = ANSI.showCursor;
const CLEAR_SCREEN = ANSI.clearScreen;
const HOME_CURSOR = ANSI.homeCursor;
const CLEAR_LINE = ANSI.clearLine;
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const PENDING_ESCAPE_MS = 25;
const FALLBACK_PRICING_NOTE = "Some rows used fallback pricing for unrecognized model ids.";
const UNPRICED_NOTE = `Some calls have no rate available; their cost reads ${UNPRICED_TEXT} and is left out of totals.`;

export function formatCostEstimateNote() {
  return [
    "Cost estimate:",
    "  Fireworks-served model estimate per request: (input * input rate + cache writes * cache-write rates + cache reads * cache-read rate + output * output rate) / 1,000,000.",
    `  Anthropic model usage is fetched from session logs; estimated cost is calculated from local rates and may be affected by tool usage, inference service tier and location, and other factors. Reference: ${ANTHROPIC_PRICING_DOCS_URL}`,
    "  ***All pricing shown below are estimates based on token usage, please refer to service-specific billing pages for actual cost information***",
  ];
}

function useColor(stream = stdout) {
  return colorEnabled(stream);
}

function paint(color, text, stream = stdout) {
  return useColor(stream) ? `${color}${text}${RESET}` : text;
}

function dim(text, stream = stdout) {
  return paint(DIM, text, stream);
}

function visibleWidth(text) {
  return String(text).replace(ANSI_PATTERN, "").length;
}

function padRight(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function padLeft(text, width) {
  return `${" ".repeat(Math.max(0, width - visibleWidth(text)))}${text}`;
}

function padLine(left, right, width) {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function fitLine(text, width) {
  if (visibleWidth(text) <= width) return text;
  return `${String(text).replace(ANSI_PATTERN, "").slice(0, Math.max(0, width - 1))}…`;
}

function selectedLine(text, width, stream = stdout) {
  const padded = padRight(fitLine(text, width), width);
  if (!useColor(stream)) return padded;
  return `${SELECTED_BG}${padded.replaceAll(RESET, `${RESET}${SELECTED_BG}`)}${RESET}`;
}

function wrapPlainLine(text, width) {
  if (text.length <= width) return [text];
  const indent = text.match(/^\s*/)?.[0] ?? "";
  const wrapped = [];
  let remaining = text;
  while (remaining.length > width) {
    const limit = Math.max(1, width);
    const breakAt = remaining.lastIndexOf(" ", limit);
    const index = breakAt > indent.length ? breakAt : limit;
    wrapped.push(remaining.slice(0, index).trimEnd());
    remaining = `${indent}${remaining.slice(index).trimStart()}`;
  }
  wrapped.push(remaining);
  return wrapped;
}

function formatInteractiveEstimateNote(width, stream = stdout, { estimated = false, unpriced = 0 } = {}) {
  const lines = formatCostEstimateNote();
  if (estimated) lines.push(FALLBACK_PRICING_NOTE);
  if (unpriced) lines.push(UNPRICED_NOTE);
  return lines
    .flatMap((line) => wrapPlainLine(line, width))
    .map((line) => dim(line, stream));
}

function fmtInt(value) {
  return value.toLocaleString("en-US");
}

function fmtCompact(value) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 2).replace(/\.0+$/, "")}M`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(absolute >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  }
  return fmtInt(value);
}

// An unpriced call has `cost: null` (see report.mjs) — a rate we could not look
// up, not a free call — so every cost cell here renders it as `n/a` and every
// total that contains one is null too.
function fmtCost(value) {
  if (value == null) {
    return UNPRICED_TEXT;
  }
  return usageCostDigits(value);
}

function fmtCostUsd(value) {
  return value == null ? UNPRICED_TEXT : `$${fmtCost(value)}`;
}

function displayModelName(model) {
  for (const prefix of ["accounts/fireworks/models/", "accounts/fireworks/routers/"]) {
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }
  }
  return model;
}

function sessionId(report) {
  return path.basename(report.path, ".jsonl");
}

function shortSessionId(id) {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function sessionName(report) {
  if (typeof report?.sessionName !== "string") {
    return "";
  }
  return report.sessionName.replace(/\s+/g, " ").trim();
}

function truncateLabel(text, maxWidth) {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  return `${text.slice(0, maxWidth - 1)}…`;
}

function formatSessionNameLines(report, width, stream = stdout) {
  const name = sessionName(report);
  if (!name) return [];
  const label = dim("NAME", stream);
  const prefix = `    ${label}  `;
  const budget = Math.max(8, width - visibleWidth(prefix));
  return [`${prefix}${paint(EMPHASIS, truncateLabel(name, budget), stream)}`];
}

function lineWidth(stream = stdout) {
  const columns = Number(stream.columns) || Number(process.env.COLUMNS) || 80;
  return Math.min(Math.max(columns, 44), 140);
}

function horizontalRule(width, stream = stdout) {
  return dim("─".repeat(width), stream);
}

/**
 * Render a fully filled bar split proportionally across segments. Uses the
 * largest-remainder method so the rendered bar is always exactly `width` cells.
 * @param {{ value: number, color: string, label?: string }[]} segments
 * @param {number} width
 * @param {NodeJS.WriteStream} [stream]
 */
export function renderSegmentedBar(segments, width, stream = stdout) {
  const safeWidth = Math.max(0, Math.floor(width));
  const positive = segments.filter((segment) => Number.isFinite(segment.value) && segment.value > 0);
  const total = positive.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0 || safeWidth <= 0) {
    return dim("░".repeat(safeWidth), stream);
  }

  const allocations = positive.map((segment, index) => {
    const exact = (segment.value / total) * safeWidth;
    return { ...segment, index, cells: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = safeWidth - allocations.reduce((sum, segment) => sum + segment.cells, 0);
  const byRemainder = [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) {
    byRemainder[index % byRemainder.length].cells += 1;
  }

  return allocations.map((segment) => paint(segment.color, "█".repeat(segment.cells), stream)).join("");
}

function renderShareBar(fraction, width, stream = stdout) {
  const safeWidth = Math.max(0, Math.floor(width));
  const filled = Math.min(safeWidth, Math.max(fraction > 0 ? 1 : 0, Math.round(fraction * safeWidth)));
  return `${paint(SPEND, "█".repeat(filled), stream)}${dim("░".repeat(safeWidth - filled), stream)}`;
}

function summarizeRows(report) {
  const byModelAndAgent = new Map();
  const ingest = (row, subagentId = "Parent") => {
    const key = `${subagentId}|${row.model}`;
    const current = byModelAndAgent.get(key) ?? {
      subagentId,
      model: row.model,
      displayModel: row.displayModel ?? displayModelName(row.model),
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cost: 0,
    };
    byModelAndAgent.set(key, {
      ...current,
      ...addUsage(current, row),
      calls: current.calls + 1,
    });
  };

  for (const row of report.rows) ingest(row);
  for (const subagent of report.subagents ?? []) {
    for (const row of subagent.rows) ingest(row, subagent.id);
  }
  return [...byModelAndAgent.values()];
}

function aggregateModels(reports) {
  const byModel = new Map();
  for (const report of reports) {
    for (const row of summarizeRows(report)) {
      const current = byModel.get(row.model) ?? {
        model: row.model,
        displayModel: row.displayModel,
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cost: 0,
      };
      byModel.set(row.model, {
        ...current,
        ...addUsage(current, row),
        calls: current.calls + row.calls,
      });
    }
  }
  return [...byModel.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || a.displayModel.localeCompare(b.displayModel));
}

function formatHero({ totals, calls, sessions }, width, stream = stdout) {
  const spend = bold(paint(PRIMARY, fmtCostUsd(totals.cost), stream), stream);
  const tokenSummary = `${paint(INPUT, fmtCompact(totals.input), stream)} in · ${paint(OUTPUT, fmtCompact(totals.output), stream)} out`;

  if (width < 68) {
    return [
      padLine(dim("TOTAL SPEND", stream), spend, width),
      padLine(dim("CALLS", stream), fmtInt(calls), width),
      padLine(dim("SESSIONS", stream), fmtInt(sessions), width),
      padLine(dim("TOKENS", stream), tokenSummary, width),
    ];
  }

  const widths = [16, 12, 12, width - 40];
  const labels = ["TOTAL SPEND", "CALLS", "SESSIONS", "TOKENS"];
  const values = [spend, fmtInt(calls), fmtInt(sessions), tokenSummary];
  return [
    labels.map((label, index) => padRight(dim(label, stream), widths[index])).join(""),
    values.map((value, index) => padRight(value, widths[index])).join(""),
  ];
}

function formatSessionRow(report, stream = stdout) {
  const id = paint(EMPHASIS, shortSessionId(sessionId(report)), stream);
  const name = sessionName(report);
  if (!name) {
    return `${dim("▾", stream)} ${id}`;
  }
  return `${dim("▾", stream)} ${id}  ${dim(name, stream)}`;
}

function sessionSummaryLayout(width, { hasNames = false } = {}) {
  const idWidth = hasNames ? Math.min(36, Math.max(18, Math.floor(width * 0.34))) : 10;
  const costWidth = 9;
  const callsWidth = 10;
  const percentWidth = 4;
  const fixedWidth = 2 + idWidth + 1 + costWidth + 1 + callsWidth + 1 + 1 + percentWidth;
  return {
    idWidth,
    costWidth,
    callsWidth,
    percentWidth,
    barWidth: Math.max(4, width - fixedWidth),
  };
}

function formatSessionLabel(report, width, stream = stdout, { expanded = false } = {}) {
  const idColor = expanded ? EMPHASIS : ACCENT;
  const id = paint(idColor, shortSessionId(sessionId(report)), stream);
  const name = sessionName(report);
  if (!name || width < 14) {
    return { label: id, width: Math.max(10, visibleWidth(id)) };
  }
  const nameBudget = Math.max(0, width - visibleWidth(id) - 1);
  if (nameBudget < 3) {
    return { label: id, width: Math.max(10, visibleWidth(id)) };
  }
  const shown = truncateLabel(name, nameBudget);
  const label = `${id} ${dim(shown, stream)}`;
  return { label, width: visibleWidth(label) };
}

function formatSessionSummaryHeader(width, stream = stdout, { hasNames = false } = {}) {
  const layout = sessionSummaryLayout(width, { hasNames });
  const sessionHeader = hasNames ? "SESSION" : "SESSION ID";
  return `  ${padRight(dim(sessionHeader, stream), layout.idWidth)} ${padLeft(dim("COST", stream), layout.costWidth)} ${padLeft(dim("CALLS", stream), layout.callsWidth)} ${padRight(dim("SHARE", stream), layout.barWidth)} ${padLeft(dim("%", stream), layout.percentWidth)}`;
}

function formatSessionSummaryRow(report, maxCost, totalCost, width, stream = stdout, { hasNames = false } = {}) {
  const layout = sessionSummaryLayout(width, { hasNames });
  const { label } = formatSessionLabel(report, layout.idWidth, stream);
  const calls = `${fmtInt(report.grandRequests)} call${report.grandRequests === 1 ? "" : "s"}`;
  const totalShare = totalCost > 0 ? report.grandTotals.cost / totalCost : 0;
  const maxShare = maxCost > 0 ? report.grandTotals.cost / maxCost : 0;
  return `${dim("▸", stream)} ${padRight(label, layout.idWidth)} ${padLeft(fmtCostUsd(report.grandTotals.cost), layout.costWidth)} ${padLeft(calls, layout.callsWidth)} ${renderShareBar(maxShare, layout.barWidth, stream)} ${padLeft(dim(`${Math.round(totalShare * 100)}%`, stream), layout.percentWidth)}`;
}

function formatInteractiveSessionRow({ report, maxCost, totalCost, width, selected, expanded }, stream = stdout) {
  // 9, like every other cost column: four decimals make `$116.9562` the widest
  // realistic cell, and a narrower slot would push the bar out of alignment.
  const costWidth = 9;
  const percentWidth = 5;
  const marker = dim(expanded ? "▾" : "▸", stream);
  const reserved = 2 + 1 + costWidth + 1 + 4 + 1 + percentWidth;
  const labelWidth = Math.max(12, Math.min(44, width - reserved));
  const { label } = formatSessionLabel(report, labelWidth, stream, { expanded });
  const barWidth = Math.min(36, Math.max(4, width - (2 + labelWidth + 1 + costWidth + 1 + 1 + percentWidth)));
  const totalShare = totalCost > 0 ? report.grandTotals.cost / totalCost : 0;
  const maxShare = maxCost > 0 ? report.grandTotals.cost / maxCost : 0;
  const row = `${marker} ${padRight(label, labelWidth)} ${padLeft(fmtCostUsd(report.grandTotals.cost), costWidth)} ${renderShareBar(maxShare, barWidth, stream)} ${padLeft(dim(`${Math.round(totalShare * 100)}%`, stream), percentWidth)}`;
  return selected ? selectedLine(row, width, stream) : fitLine(row, width);
}

function formatModelBreakdown(report, width, stream = stdout) {
  const models = aggregateModels([report]);
  if (models.length === 0) return [];

  const totalCost = report.grandTotals.cost;
  const maxCost = Math.max(...models.map((model) => model.cost), 0);
  // Give model ids enough room on normal/wide terminals without starving the
  // cost bar on narrow ones. At 100 columns this grows from 24 to 36 cells.
  const nameWidth = Math.min(36, Math.max(14, Math.floor(width * 0.36)));
  const fixedWidth = 4 + nameWidth + 1 + 9 + 1 + 1 + 4;
  const barWidth = Math.max(5, width - fixedWidth);
  const lines = [
    `   ${padRight(dim("MODEL", stream), nameWidth)} ${padLeft(dim("COST", stream), 9)} ${padRight(dim("SHARE", stream), barWidth)} ${padLeft(dim("%", stream), 4)}`,
  ];
  for (const model of models) {
    const name = model.displayModel.length > nameWidth
      ? `${model.displayModel.slice(0, nameWidth - 1)}…`
      : model.displayModel;
    const share = totalCost > 0 ? model.cost / totalCost : 0;
    const modelColor = model.model.includes("claude") ? CLAUDE_MODEL : FIREWORKS_MODEL;
    lines.push(`   ${padRight(paint(modelColor, name, stream), nameWidth)} ${padLeft(fmtCostUsd(model.cost), 9)} ${renderShareBar(maxCost > 0 ? model.cost / maxCost : 0, barWidth, stream)} ${padLeft(dim(`${Math.round(share * 100)}%`, stream), 4)}`);
    lines.push(dim(`     ${fmtInt(model.calls)} call${model.calls === 1 ? "" : "s"} · ${fmtCompact(model.input)} in · ${fmtCompact(model.output)} out${model.cacheRead ? ` · ${fmtCompact(model.cacheRead)} cache read` : ""}`, stream));
  }
  return lines;
}

function formatInteractiveModelBreakdown(report, width, stream = stdout) {
  const models = aggregateModels([report]);
  if (models.length === 0) return [];

  const totalCost = report.grandTotals.cost;
  const maxCost = Math.max(...models.map((model) => model.cost), 0);
  const nameWidth = Math.min(36, Math.max(14, Math.floor(width * 0.24)));
  const costWidth = 9;
  const percentWidth = 4;
  const indent = "    ";
  const fixedWidth = visibleWidth(indent) + nameWidth + 2 + costWidth + 2 + percentWidth;
  const barWidth = Math.max(5, Math.min(36, width - fixedWidth));
  const lines = [];

  for (const model of models) {
    const name = model.displayModel.length > nameWidth
      ? `${model.displayModel.slice(0, nameWidth - 1)}…`
      : model.displayModel;
    const share = totalCost > 0 ? model.cost / totalCost : 0;
    const modelColor = model.model.includes("claude") ? CLAUDE_MODEL : FIREWORKS_MODEL;
    lines.push(fitLine(`${indent}${padRight(paint(modelColor, name, stream), nameWidth)}  ${padLeft(fmtCostUsd(model.cost), costWidth)}  ${renderShareBar(maxCost > 0 ? model.cost / maxCost : 0, barWidth, stream)}  ${padLeft(dim(`${Math.round(share * 100)}%`, stream), percentWidth)}`, width));
  }
  return lines;
}

function requestRows(report, sourceFilter = "") {
  const rows = [];
  report.rows.forEach((row, index) => {
    rows.push({ source: "parent", request: index + 1, row });
  });
  for (const subagent of report.subagents ?? []) {
    subagent.rows.forEach((row, index) => {
      rows.push({ source: subagent.id, request: index + 1, row });
    });
  }
  return sourceFilter ? rows.filter((item) => item.source === sourceFilter) : rows;
}

function sourceLabel(source) {
  return source === "parent" ? "parent" : `sub-agent ${source}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function totalsForRequestItems(items) {
  return sumUsage(items.map((item) => item.row));
}

function sourceModelRows(report) {
  const bySourceAndModel = new Map();
  const ingest = (source, row) => {
    const key = `${source}|${row.model}`;
    const current = bySourceAndModel.get(key) ?? {
      source,
      model: row.model,
      displayModel: row.displayModel ?? displayModelName(row.model),
      calls: 0,
      input: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 0,
      cost: 0,
    };
    bySourceAndModel.set(key, {
      ...current,
      ...addUsage(current, row),
      calls: current.calls + 1,
    });
  };

  for (const row of report.rows) ingest("parent", row);
  for (const subagent of report.subagents ?? []) {
    for (const row of subagent.rows) ingest(subagent.id, row);
  }

  return [...bySourceAndModel.values()].sort((a, b) => {
    if (a.source === "parent" && b.source !== "parent") return -1;
    if (b.source === "parent" && a.source !== "parent") return 1;
    return a.source.localeCompare(b.source) || a.displayModel.localeCompare(b.displayModel);
  });
}

function formatSourceBreakdown(report, width, stream = stdout, { offset = 0, limit = Infinity, focusIndex = 0 } = {}) {
  const rows = sourceModelRows(report);
  if (rows.length === 0) return [];
  const visibleLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : rows.length;
  const maxOffset = Math.max(0, rows.length - visibleLimit);
  const safeOffset = Math.min(Math.max(0, Math.floor(offset)), maxOffset);
  const safeFocus = clamp(focusIndex, 0, Math.max(0, rows.length - 1));
  const visibleRows = rows.slice(safeOffset, safeOffset + visibleLimit);
  const indent = "      ";
  const sourceWidth = width >= 112 ? 27 : 16;
  const callsWidth = 5;
  const tokenWidth = width >= 112 ? 11 : 9;
  const costWidth = 9;
  const gapsWidth = 2 * 8;
  const modelWidth = Math.max(10, width - visibleWidth(indent) - sourceWidth - callsWidth - (tokenWidth * 5) - costWidth - gapsWidth);
  const lines = [
    `${indent}${padRight(dim("SESSION MODEL / SUB-AGENT", stream), sourceWidth)}  ${padRight(dim("MODEL", stream), modelWidth)}  ${padLeft(dim("CALLS", stream), callsWidth)}  ${padLeft(dim("INPUT", stream), tokenWidth)}  ${padLeft(dim("5M WRITE", stream), tokenWidth)}  ${padLeft(dim("1H WRITE", stream), tokenWidth)}  ${padLeft(dim("CACHE RD", stream), tokenWidth)}  ${padLeft(dim("OUTPUT", stream), tokenWidth)}  ${padLeft(dim("COST", stream), costWidth)}`,
  ];

  visibleRows.forEach((row, index) => {
    const source = sourceLabel(row.source);
    const sourceText = source.length > sourceWidth ? `${source.slice(0, sourceWidth - 1)}…` : source;
    const modelText = row.displayModel.length > modelWidth ? `${row.displayModel.slice(0, modelWidth - 1)}…` : row.displayModel;
    const modelColor = row.model.includes("claude") ? CLAUDE_MODEL : FIREWORKS_MODEL;
    const line = fitLine(
      `${indent}${padRight(dim(sourceText, stream), sourceWidth)}  ${padRight(paint(modelColor, modelText, stream), modelWidth)}  ${padLeft(fmtInt(row.calls), callsWidth)}  ${padLeft(paint(INPUT, fmtInt(row.input), stream), tokenWidth)}  ${padLeft(fmtInt(row.cacheWrite5m), tokenWidth)}  ${padLeft(fmtInt(row.cacheWrite1h), tokenWidth)}  ${padLeft(fmtInt(row.cacheRead), tokenWidth)}  ${padLeft(paint(OUTPUT, fmtInt(row.output), stream), tokenWidth)}  ${padLeft(fmtCost(row.cost), costWidth)}`,
      width,
    );
    lines.push(safeOffset + index === safeFocus ? selectedLine(line, width, stream) : line);
  });

  lines.push(fitLine(`${indent}${"─".repeat(Math.max(8, Math.min(48, width - visibleWidth(indent))))}`, width));
  lines.push(fitLine(`${indent}${padRight("TOTAL", sourceWidth + 2 + modelWidth)}  ${padLeft(fmtInt(report.grandRequests), callsWidth)}  ${padLeft(paint(INPUT, fmtInt(report.grandTotals.input), stream), tokenWidth)}  ${padLeft(fmtInt(report.grandTotals.cacheWrite5m ?? 0), tokenWidth)}  ${padLeft(fmtInt(report.grandTotals.cacheWrite1h ?? 0), tokenWidth)}  ${padLeft(fmtInt(report.grandTotals.cacheRead ?? 0), tokenWidth)}  ${padLeft(paint(OUTPUT, fmtInt(report.grandTotals.output), stream), tokenWidth)}  ${padLeft(fmtCost(report.grandTotals.cost), costWidth)}`, width));
  if (rows.length > visibleRows.length) {
    const first = safeOffset + 1;
    const last = safeOffset + visibleRows.length;
    lines.push(dim(`${indent}rows ${first}-${last} of ${rows.length} · ↑/↓ move · PgUp/PgDn page · → requests · ← back · q quit`, stream));
  } else {
    lines.push(dim(`${indent}${rows.length} row${rows.length === 1 ? "" : "s"} · ↑/↓ move · → requests · ← back · q quit`, stream));
  }
  return lines;
}

function formatRequestDetailRows(report, width, stream = stdout, { source = "", offset = 0, limit = Infinity } = {}) {
  const rows = requestRows(report, source);
  if (rows.length === 0) return [];
  const visibleLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : rows.length;
  const maxOffset = Math.max(0, rows.length - visibleLimit);
  const safeOffset = Math.min(Math.max(0, Math.floor(offset)), maxOffset);
  const visibleRows = rows.slice(safeOffset, safeOffset + visibleLimit);
  const totals = totalsForRequestItems(rows);

  const indent = "      ";
  const costWidth = 9;
  const reqWidth = 4;
  const tokenWidth = width >= 112 ? 11 : 9;
  const sourceWidth = width >= 112 ? 20 : 10;
  const gapsWidth = 2 * 8;
  const modelWidth = Math.max(10, width - visibleWidth(indent) - reqWidth - sourceWidth - (tokenWidth * 5) - costWidth - gapsWidth);
  const lines = [
    `${indent}${padLeft(dim("REQ", stream), reqWidth)}  ${padRight(dim("SOURCE", stream), sourceWidth)}  ${padRight(dim("MODEL", stream), modelWidth)}  ${padLeft(dim("INPUT", stream), tokenWidth)}  ${padLeft(dim("5M WRITE", stream), tokenWidth)}  ${padLeft(dim("1H WRITE", stream), tokenWidth)}  ${padLeft(dim("CACHE RD", stream), tokenWidth)}  ${padLeft(dim("OUTPUT", stream), tokenWidth)}  ${padLeft(dim("COST", stream), costWidth)}`,
  ];

  for (const item of visibleRows) {
    const source = sourceLabel(item.source);
    const sourceText = source.length > sourceWidth ? `${source.slice(0, sourceWidth - 1)}…` : source;
    const model = item.row.displayModel ?? displayModelName(item.row.model);
    const modelText = model.length > modelWidth ? `${model.slice(0, modelWidth - 1)}…` : model;
    const modelColor = item.row.model.includes("claude") ? CLAUDE_MODEL : FIREWORKS_MODEL;
    lines.push(fitLine(
      `${indent}${padLeft(`#${item.request}`, reqWidth)}  ${padRight(dim(sourceText, stream), sourceWidth)}  ${padRight(paint(modelColor, modelText, stream), modelWidth)}  ${padLeft(paint(INPUT, fmtInt(item.row.input), stream), tokenWidth)}  ${padLeft(fmtInt(item.row.cacheWrite5m ?? 0), tokenWidth)}  ${padLeft(fmtInt(item.row.cacheWrite1h ?? 0), tokenWidth)}  ${padLeft(fmtInt(item.row.cacheRead ?? 0), tokenWidth)}  ${padLeft(paint(OUTPUT, fmtInt(item.row.output), stream), tokenWidth)}  ${padLeft(fmtCost(item.row.cost), costWidth)}`,
      width,
    ));
  }

  lines.push(fitLine(`${indent}${"─".repeat(Math.max(8, Math.min(48, width - visibleWidth(indent))))}`, width));
  lines.push(fitLine(`${indent}${padRight(`TOTAL ${sourceLabel(source)}`, reqWidth + 2 + sourceWidth + 2 + modelWidth)}  ${padLeft(paint(INPUT, fmtInt(totals.input), stream), tokenWidth)}  ${padLeft(fmtInt(totals.cacheWrite5m), tokenWidth)}  ${padLeft(fmtInt(totals.cacheWrite1h), tokenWidth)}  ${padLeft(fmtInt(totals.cacheRead), tokenWidth)}  ${padLeft(paint(OUTPUT, fmtInt(totals.output), stream), tokenWidth)}  ${padLeft(fmtCost(totals.cost), costWidth)}`, width));
  if (rows.length > visibleRows.length) {
    const first = safeOffset + 1;
    const last = safeOffset + visibleRows.length;
    lines.push(dim(`${indent}rows ${first}-${last} of ${rows.length} · ↑/↓ scroll · PgUp/PgDn page · ← back · q quit`, stream));
  } else {
    lines.push(dim(`${indent}${rows.length} row${rows.length === 1 ? "" : "s"} · ← back · q quit`, stream));
  }
  return lines.map((line) => fitLine(line, width));
}

function usageGroupFromInput(input) {
  const sessions = input?.sessions ?? [input];
  const totals = input?.sessions ? input.grandTotals : input.grandTotals;
  const calls = input?.sessions ? input.grandRequests : input.grandRequests;
  return {
    sessions,
    totals,
    calls,
    estimated: input?.estimated ?? false,
    unpriced: input?.unpriced ?? 0,
  };
}

function reportHasUsageRows(report) {
  return (report?.rows ?? []).length > 0
    || (report?.subagents ?? []).some((subagent) => (subagent.rows ?? []).length > 0);
}

export function hasClaudeUsageRows(input) {
  return (usageGroupFromInput(input).sessions ?? []).some(reportHasUsageRows);
}

function clampFocus(state, sessionCount) {
  const focusIndex = Math.min(Math.max(0, state.focusIndex ?? 0), Math.max(0, sessionCount - 1));
  return {
    focusIndex,
    expandedSessionId: state.expandedSessionId ?? "",
    detailSessionId: state.detailSessionId ?? "",
    sourceFocusIndex: Math.max(0, state.sourceFocusIndex ?? 0),
    sourceScrollOffset: Math.max(0, state.sourceScrollOffset ?? state.detailScrollOffset ?? 0),
    requestSource: state.requestSource ?? "",
    requestScrollOffset: Math.max(0, state.requestScrollOffset ?? 0),
  };
}

function layerTableLimit(input, state, stream = stdout) {
  const viewportRows = Number(stream.rows) > 0 ? Math.max(12, Number(stream.rows) - 1) : Infinity;
  if (!Number.isFinite(viewportRows) || !state.detailSessionId) return Infinity;

  const group = usageGroupFromInput(input);
  const sessions = group.sessions ?? [];
  const report = sessions.find((session) => sessionId(session) === state.detailSessionId);
  if (!report) return Infinity;

  const width = lineWidth(stream);
  const heroRows = formatHero({ totals: group.totals, calls: group.calls, sessions: sessions.length }, width, stream).length;
  const estimateRows = formatInteractiveEstimateNote(width, stream, { estimated: group.estimated, unpriced: group.unpriced }).length;
  const modelRows = formatInteractiveModelBreakdown(report, width, stream).length;
  const nameRows = formatSessionNameLines(report, width, stream).length > 0 ? 2 : 0;
  const fixedRows = 1 + 1 + estimateRows + 1 + heroRows + 1 + 1 + 1
    + 1 + nameRows + 1 + modelRows + 1 + 1
    + 5;
  return Math.max(1, viewportRows - fixedRows);
}

export function formatClaudeUsageInteractiveFrame(input, state = {}, { stream = stdout } = {}) {
  const group = usageGroupFromInput(input);
  const sessions = group.sessions ?? [];
  if (sessions.length === 0) return "No Claude Code session usage found.";

  const width = lineWidth(stream);
  const view = clampFocus(state, sessions.length);
  const detailMode = Boolean(view.detailSessionId);
  const requestMode = Boolean(view.requestSource);
  const title = sessions.length === 1
    ? "nexus usage · last 1 session"
    : `nexus usage · last ${sessions.length} sessions`;
  const maxCost = Math.max(...sessions.map((report) => report.grandTotals.cost), 0);
  const lines = [
    dim(title, stream),
    "",
    ...formatInteractiveEstimateNote(width, stream, { estimated: group.estimated, unpriced: group.unpriced }),
    "",
    ...formatHero({ totals: group.totals, calls: group.calls, sessions: sessions.length }, width, stream),
    "",
    horizontalRule(width, stream),
    "",
  ];

  sessions.forEach((report, index) => {
    const id = sessionId(report);
    if (detailMode && id !== view.detailSessionId) return;
    const expanded = view.expandedSessionId === id || view.detailSessionId === id;
    const detailed = view.detailSessionId === id;
    lines.push(formatInteractiveSessionRow({
      report,
      maxCost,
      totalCost: group.totals.cost,
      width,
      selected: index === view.focusIndex,
      expanded,
    }, stream));
    if (expanded) {
      lines.push("");
      const nameLines = formatSessionNameLines(report, width, stream);
      if (nameLines.length > 0) {
        lines.push(...nameLines);
        lines.push("");
      }
      lines.push(...formatInteractiveModelBreakdown(report, width, stream));
      lines.push("");
      const sourceCount = sourceModelRows(report).length;
      lines.push(`    ${paint(ACCENT, `${detailed ? "▾ hide" : "▸ show"} ${sourceCount} source/model row${sourceCount === 1 ? "" : "s"}`, stream)}`);
      if (detailed) {
        if (requestMode) {
          lines.push(dim(`      requests for ${sourceLabel(view.requestSource)}`, stream));
          lines.push(...formatRequestDetailRows(report, width, stream, {
            source: view.requestSource,
            offset: view.requestScrollOffset,
            limit: layerTableLimit(input, view, stream),
          }));
        } else {
          lines.push(...formatSourceBreakdown(report, width, stream, {
            offset: view.sourceScrollOffset,
            limit: layerTableLimit(input, view, stream),
            focusIndex: view.sourceFocusIndex,
          }));
        }
      }
      lines.push("");
    }
  });

  if (!detailMode) {
    lines.push(dim("↑/↓ session   → expand/details   ← collapse   q quit", stream));
  }
  return lines.map((line) => fitLine(line, width)).join("\n");
}

function renderInteractiveFrame(input, state, { stream, previousHeight }) {
  const frame = formatClaudeUsageInteractiveFrame(input, state, { stream });
  const maxRows = Number(stream.rows) > 0 ? Math.max(12, Number(stream.rows) - 1) : Infinity;
  let lines = frame.split("\n");
  if (Number.isFinite(maxRows) && lines.length > maxRows) {
    const hidden = lines.length - maxRows + 1;
    lines = [
      ...lines.slice(0, maxRows - 1),
      dim(`… ${hidden} more line${hidden === 1 ? "" : "s"} hidden; use --verbose for the full request table`, stream),
    ];
  }

  let out = HIDE_CURSOR;
  if (previousHeight > 0) {
    out += `\u001b[${previousHeight}A`;
    for (let index = 0; index < previousHeight; index += 1) {
      out += `\r${CLEAR_LINE}\u001b[1B`;
    }
    out += `\u001b[${previousHeight}A`;
  } else {
    out += CLEAR_SCREEN + HOME_CURSOR;
  }
  out += lines.join("\n");
  stream.write(out);
  return lines.length;
}

export function canRunClaudeUsageInteractiveDisplay({ input = stdin, stream = stdout } = {}) {
  return Boolean(input.isTTY && stream.isTTY);
}

export async function runClaudeUsageInteractiveDisplay(input, { stdin: in_ = stdin, stream = stdout } = {}) {
  if (!canRunClaudeUsageInteractiveDisplay({ input: in_, stream })) return false;

  const group = usageGroupFromInput(input);
  if ((group.sessions ?? []).length === 0) {
    stream.write("No Claude Code session usage found.\n");
    return true;
  }
  if (!hasClaudeUsageRows(input)) return false;

  const state = {
    focusIndex: 0,
    expandedSessionId: "",
    detailSessionId: "",
    sourceFocusIndex: 0,
    sourceScrollOffset: 0,
    requestSource: "",
    requestScrollOffset: 0,
  };
  let previousHeight = renderInteractiveFrame(input, state, { stream, previousHeight: 0 });

  await new Promise((resolve) => {
    let done = false;
    let buffer = "";
    let pendingEscapeTimer = null;
    const wasRaw = in_.isRaw;
    const sessionAtFocus = () => group.sessions[state.focusIndex];
    const activeReport = () => group.sessions.find((report) => sessionId(report) === state.detailSessionId);
    const tableLimit = () => layerTableLimit(input, state, stream);
    const pageStep = () => Math.max(1, tableLimit() - 1);
    const sourceRowsForActiveReport = () => {
      const report = activeReport();
      return report ? sourceModelRows(report) : [];
    };
    const maxSourceOffset = () => {
      const rowCount = sourceRowsForActiveReport().length;
      const limit = tableLimit();
      return Math.max(0, rowCount - (Number.isFinite(limit) ? limit : rowCount));
    };
    const selectedSource = () => {
      const rows = sourceRowsForActiveReport();
      return rows[clamp(state.sourceFocusIndex, 0, Math.max(0, rows.length - 1))]?.source ?? "parent";
    };
    const resetSessionExpansion = () => {
      state.expandedSessionId = "";
      state.detailSessionId = "";
      state.sourceFocusIndex = 0;
      state.sourceScrollOffset = 0;
      state.requestSource = "";
      state.requestScrollOffset = 0;
    };
    const moveSessionFocus = (delta) => {
      const previousFocusIndex = state.focusIndex;
      state.focusIndex = clamp(state.focusIndex + delta, 0, Math.max(0, group.sessions.length - 1));
      if (state.focusIndex !== previousFocusIndex) resetSessionExpansion();
      return state.focusIndex !== previousFocusIndex;
    };
    const ensureSourceFocusVisible = () => {
      const rows = sourceRowsForActiveReport();
      const lastIndex = Math.max(0, rows.length - 1);
      const limit = tableLimit();
      state.sourceFocusIndex = clamp(state.sourceFocusIndex, 0, lastIndex);
      if (!Number.isFinite(limit)) {
        state.sourceScrollOffset = 0;
        return;
      }
      const visibleLimit = Math.max(1, limit);
      if (state.sourceFocusIndex < state.sourceScrollOffset) {
        state.sourceScrollOffset = state.sourceFocusIndex;
      } else if (state.sourceFocusIndex >= state.sourceScrollOffset + visibleLimit) {
        state.sourceScrollOffset = state.sourceFocusIndex - visibleLimit + 1;
      }
      state.sourceScrollOffset = clamp(state.sourceScrollOffset, 0, maxSourceOffset());
    };
    const moveSourceFocus = (delta) => {
      const previousFocusIndex = state.sourceFocusIndex;
      const previousScrollOffset = state.sourceScrollOffset;
      const rows = sourceRowsForActiveReport();
      state.sourceFocusIndex = clamp(state.sourceFocusIndex + delta, 0, Math.max(0, rows.length - 1));
      ensureSourceFocusVisible();
      return state.sourceFocusIndex !== previousFocusIndex || state.sourceScrollOffset !== previousScrollOffset;
    };
    const pageSourceFocus = (delta) => {
      if (maxSourceOffset() === 0) return false;
      return moveSourceFocus(delta);
    };
    const maxRequestOffset = () => {
      const report = activeReport();
      if (!report) return 0;
      const limit = tableLimit();
      const rowCount = requestRows(report, state.requestSource).length;
      return Math.max(0, rowCount - (Number.isFinite(limit) ? limit : rowCount));
    };
    const scrollRequest = (delta) => {
      const previousScrollOffset = state.requestScrollOffset;
      state.requestScrollOffset = clamp(state.requestScrollOffset + delta, 0, maxRequestOffset());
      return state.requestScrollOffset !== previousScrollOffset;
    };
    const rerender = () => {
      if (state.detailSessionId && state.requestSource) state.requestScrollOffset = clamp(state.requestScrollOffset, 0, maxRequestOffset());
      if (state.detailSessionId && !state.requestSource) ensureSourceFocusVisible();
      previousHeight = renderInteractiveFrame(input, state, { stream, previousHeight });
    };
    const finish = () => {
      if (done) return;
      done = true;
      if (pendingEscapeTimer) {
        clearTimeout(pendingEscapeTimer);
        pendingEscapeTimer = null;
      }
      in_.removeListener("data", onData);
      try { in_.setRawMode(wasRaw); } catch { /* noop */ }
      in_.pause();
      stream.write(`${SHOW_CURSOR}\n`);
      resolve();
    };
    const waitForEscapeSequence = () => {
      if (pendingEscapeTimer) return;
      pendingEscapeTimer = setTimeout(() => {
        pendingEscapeTimer = null;
        if (buffer === "\x1b" || buffer === "\x1b[" || /^\x1b\[[0-9]$/.test(buffer)) {
          buffer = "";
          finish();
        }
      }, PENDING_ESCAPE_MS);
    };
    const expandFocused = () => {
      const focused = sessionAtFocus();
      if (!focused) return;
      const id = sessionId(focused);
      if (state.expandedSessionId !== id && state.detailSessionId !== id) {
        state.expandedSessionId = id;
        state.detailSessionId = "";
        state.sourceFocusIndex = 0;
        state.sourceScrollOffset = 0;
        state.requestSource = "";
        state.requestScrollOffset = 0;
      } else {
        state.expandedSessionId = id;
        state.detailSessionId = id;
        state.sourceFocusIndex = 0;
        state.sourceScrollOffset = 0;
        state.requestSource = "";
        state.requestScrollOffset = 0;
      }
    };
    const drillRight = () => {
      if (!state.detailSessionId) {
        expandFocused();
        return;
      }
      if (!state.requestSource) {
        state.requestSource = selectedSource();
        state.requestScrollOffset = 0;
      }
    };
    const collapseFocused = () => {
      const focused = sessionAtFocus();
      if (!focused) return;
      const id = sessionId(focused);
      if (state.requestSource) {
        state.requestSource = "";
        state.requestScrollOffset = 0;
      } else if (state.detailSessionId === id) {
        state.detailSessionId = "";
        state.expandedSessionId = id;
        state.sourceFocusIndex = 0;
        state.sourceScrollOffset = 0;
      } else if (state.expandedSessionId === id) {
        state.expandedSessionId = "";
        state.sourceFocusIndex = 0;
        state.sourceScrollOffset = 0;
      }
    };
    const onData = (chunk) => {
      if (pendingEscapeTimer) {
        clearTimeout(pendingEscapeTimer);
        pendingEscapeTimer = null;
      }
      buffer += chunk.toString("latin1");
      while (buffer.length > 0) {
        const ch = buffer[0];
        if (ch === "\x03" || ch === "q" || ch === "Q") {
          buffer = buffer.slice(1);
          finish();
          return;
        }
        if (ch === "\r" || ch === "\n") {
          buffer = buffer.slice(1);
          drillRight();
          rerender();
          continue;
        }
        if (ch === "\x1b") {
          if (buffer.length < 2 || (buffer[1] === "[" && (buffer.length < 3 || (/[0-9]/.test(buffer[2]) && buffer.length < 4)))) {
            waitForEscapeSequence();
            return;
          }
          if (buffer.length >= 3 && buffer[1] === "[") {
            const code = buffer[2];
            const suffix = buffer[3];
            if (/[0-9]/.test(code)) {
              buffer = suffix === "~" ? buffer.slice(4) : buffer.slice(3);
              let changed = false;
              if (code === "5") {
                if (state.requestSource) changed = scrollRequest(-pageStep());
                else if (state.detailSessionId) changed = pageSourceFocus(-pageStep());
              }
              if (code === "6") {
                if (state.requestSource) changed = scrollRequest(pageStep());
                else if (state.detailSessionId) changed = pageSourceFocus(pageStep());
              }
              if (changed) rerender();
              continue;
            }
            buffer = buffer.slice(3);
            if (code === "A") {
              if (state.requestSource) scrollRequest(-1);
              else if (state.detailSessionId) moveSourceFocus(-1);
              else moveSessionFocus(-1);
            }
            if (code === "B") {
              if (state.requestSource) scrollRequest(1);
              else if (state.detailSessionId) moveSourceFocus(1);
              else moveSessionFocus(1);
            }
            if (code === "C") drillRight();
            if (code === "D") collapseFocused();
            rerender();
            continue;
          }
          buffer = buffer.slice(1);
          finish();
          return;
        }
        if (ch === "j" || ch === "J") {
          buffer = buffer.slice(1);
          if (state.requestSource) scrollRequest(1);
          else if (state.detailSessionId) moveSourceFocus(1);
          else moveSessionFocus(1);
          rerender();
          continue;
        }
        if (ch === "k" || ch === "K") {
          buffer = buffer.slice(1);
          if (state.requestSource) scrollRequest(-1);
          else if (state.detailSessionId) moveSourceFocus(-1);
          else moveSessionFocus(-1);
          rerender();
          continue;
        }
        buffer = buffer.slice(1);
      }
    };

    in_.setEncoding("latin1");
    in_.resume();
    in_.setRawMode(true);
    in_.on("data", onData);
  });

  return true;
}

function formatEstimateFooter({ estimated, unpriced = 0 }, stream = stdout) {
  const lines = [
    "",
    ...formatCostEstimateNote().map((line) => dim(line, stream)),
    dim("Use -v / --verbose for request and sub-agent details.", stream),
  ];
  if (estimated) {
    lines.push(dim(FALLBACK_PRICING_NOTE, stream));
  }
  if (unpriced) {
    lines.push(dim(UNPRICED_NOTE, stream));
  }
  return lines;
}

function formatSessionDetail(report, title, width, stream = stdout) {
  const name = sessionName(report);
  const lines = [
    "",
    dim(title, stream),
    "",
    ...formatHero({ totals: report.grandTotals, calls: report.grandRequests, sessions: 1 }, width, stream),
    "",
    horizontalRule(width, stream),
    dim(name ? "SESSION" : "SESSION ID", stream),
    formatSessionRow(report, stream),
    ...formatModelBreakdown(report, width, stream),
  ];

  const subagentCount = (report.subagents ?? []).filter((subagent) => subagent.rows.length > 0).length;
  if (subagentCount > 0) {
    lines.push(dim(`   ${subagentCount} sub-agent${subagentCount === 1 ? "" : "s"} included in model totals.`, stream));
  }
  return lines;
}

function formatSummary({ sessions, totals, calls, estimated, unpriced = 0 }, stream = stdout) {
  const width = lineWidth(stream);
  const lines = [];
  const hasNames = sessions.some((report) => Boolean(sessionName(report)));

  if (sessions.length === 1) {
    lines.push(...formatSessionDetail(sessions[0], "nexus usage · last 1 session", width, stream));
  } else {
    sessions.forEach((report, index) => {
      lines.push(...formatSessionDetail(
        report,
        `nexus usage · session ${index + 1} of ${sessions.length}`,
        width,
        stream,
      ));
    });

    const maxCost = Math.max(...sessions.map((report) => report.grandTotals.cost), 0);
    lines.push(
      "",
      dim(`nexus usage · last ${sessions.length} sessions`, stream),
      "",
      ...formatHero({ totals, calls, sessions: sessions.length }, width, stream),
      "",
      horizontalRule(width, stream),
      formatSessionSummaryHeader(width, stream, { hasNames }),
    );
    for (const report of sessions) {
      lines.push(formatSessionSummaryRow(report, maxCost, totals.cost, width, stream, { hasNames }));
    }
  }

  lines.push(...formatEstimateFooter({ estimated, unpriced }, stream));
  return lines.join("\n");
}

/** Brief, deterministic version of the designer's pixel firework. */
export async function playUsageIntroAnimation(stream = stdout) {
  if (!stream.isTTY || !useColor(stream) || process.env.NEXUS_NO_USAGE_ANIMATION) return;

  const blank = ["       ", "       ", "       ", "       ", "       "];
  const frames = [
    blank,
    ["       ", "       ", "   .   ", "   |   ", "   '   "],
    ["       ", "   .   ", "   |   ", "   '   ", "       "],
    ["   .   ", "  .*.  ", "   .   ", "       ", "       "],
    ["   .   ", "  .:.  ", " .:*:. ", "  .:.  ", "   .   "],
    [" . : . ", " .:*:. ", ".:*+*:. ", " .:*:. ", " . : . "],
    ["'  :  '", " .:*:. ", ".: + :.", " .:*:. ", "'  :  '"],
    [".     .", "   :   ", " ' + ' ", "   :   ", ".     ."],
    [".     .", "       ", "   +   ", "       ", ".     ."],
    blank,
  ];

  for (let index = 0; index < frames.length; index += 1) {
    if (index > 0) stream.write("\u001b[5A");
    for (const line of frames[index]) stream.write(`${paint(PRIMARY, line, stream)}\u001b[K\n`);
    await new Promise((resolve) => setTimeout(resolve, 85));
  }
  stream.write("\u001b[5A");
  for (let row = 0; row < 5; row += 1) stream.write("\u001b[2K\n");
  stream.write("\u001b[5A");
}

export function formatClaudeUsageSummaryDisplay(report, { stream = stdout } = {}) {
  if (report.rows.length === 0 && (report.subagents ?? []).length === 0) {
    return `No assistant entries found in ${report.path}`;
  }
  return formatSummary({
    sessions: [report],
    totals: report.grandTotals,
    calls: report.grandRequests,
    estimated: report.estimated,
    unpriced: report.unpriced,
  }, stream);
}

export function formatClaudeUsageReportsSummaryDisplay(reportGroup, { stream = stdout } = {}) {
  const sessions = reportGroup.sessions ?? [];
  if (sessions.length === 0) return "No Claude Code session usage found.";
  return formatSummary({
    sessions,
    totals: reportGroup.grandTotals,
    calls: reportGroup.grandRequests,
    estimated: reportGroup.estimated,
    unpriced: reportGroup.unpriced,
  }, stream);
}
