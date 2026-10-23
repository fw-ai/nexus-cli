import { terminalTheme } from "./color.mjs";
import { CLI_COLORS, DATA_COLORS } from "./tokens.mjs";

/**
 * @param {string} hex `#RRGGBB`
 * @returns {string} truecolor foreground SGR
 */
export function truecolor(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\u001b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}

const CLI = CLI_COLORS[terminalTheme()];

/**
 * @param {string} hex `#RRGGBB`
 * @returns {string} SGR params without `\x1b[` / `m`
 */
function truecolorParams(hex) {
  return truecolor(hex).slice(2, -1);
}

/** Roles in usage tables and meters, drawn from {@link DATA_COLORS}. */
export const DATA = Object.freeze({
  input: truecolor(DATA_COLORS.teal),
  output: truecolor(DATA_COLORS.green),
  claudeModel: truecolor(DATA_COLORS.coral),
  fireworksModel: truecolor(DATA_COLORS.rose),
  spend: truecolor(DATA_COLORS.coral),
  cost: truecolor(DATA_COLORS.peach),
});

/** Raw ANSI sequences — shared by CLI output, usage dashboard, and demo TUI. */
export const ANSI = Object.freeze({
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dimFaint: "\u001b[2m",
  muted: "\u001b[90m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  primary: truecolor(CLI.primary),
  accent: truecolor(CLI.accent),
  selectedBg: "\u001b[48;5;236m",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  clearScreen: "\u001b[2J",
  homeCursor: "\u001b[H",
  clearLine: "\u001b[K",
  // Alternate screen buffer. A fullscreen view that repaints in place must run
  // here: `[2J` clears what you can SEE, but every repainted frame still lands
  // in scrollback, so the pane grows without bound and buries the user's shell
  // history. Enter on start, leave on exit and the terminal restores whatever
  // was on screen before, exactly like vim or less.
  enterAltScreen: "\u001b[?1049h",
  exitAltScreen: "\u001b[?1049l",
});

/**
 * Live cost-meter palette.
 * Kept here so `nexus claude usage` and the meter share one source.
 */
export const METER = Object.freeze({
  accent: truecolor(CLI.primary),
  gold: DATA.cost,
  ghost: "\u001b[38;5;245m",
  green: DATA.output,
  red: "\u001b[31m",
  /** SGR color params (without `\x1b[` / `m`) for per-model badges. */
  modelPalette: Object.freeze([
    DATA_COLORS.teal,
    DATA_COLORS.coral,
    DATA_COLORS.rose,
    DATA_COLORS.green,
    DATA_COLORS.peach,
    DATA_COLORS.blush,
    DATA_COLORS.sky,
    DATA_COLORS.amber,
    DATA_COLORS.flare,
  ].map(truecolorParams)),
});

