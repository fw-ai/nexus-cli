import { BRAND } from "./tokens.mjs";

/** Raw ANSI sequences — shared by CLI output, usage dashboard, and demo TUI. */
export const ANSI = Object.freeze({
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dimFaint: "\u001b[2m",
  muted: "\u001b[90m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  white: "\u001b[97m",
  orange: "\u001b[38;5;208m",
  blue: "\u001b[36m",
  violet: "\u001b[38;5;105m",
  purple: `\u001b[38;2;103;32;255m`,
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
 * Live cost-meter palette (same codes as claude-transparent / PR #230).
 * Kept here so `nexus claude usage` and the meter share one source.
 */
export const METER = Object.freeze({
  accent: "\u001b[38;2;103;32;255m",
  gold: "\u001b[38;5;220m",
  ghost: "\u001b[38;5;245m",
  green: "\u001b[38;5;42m",
  red: "\u001b[38;5;203m",
  /** SGR color params (without `\x1b[` / `m`) for per-model badges. */
  modelPalette: Object.freeze([
    "38;5;141",
    "38;5;43",
    "38;5;215",
    "38;5;75",
    "38;5;205",
    "38;5;191",
    "38;5;117",
  ]),
});

/** Brand purple as RGB tuple (matches BRAND.purple #6720FF). */
export const BRAND_RGB = Object.freeze({ r: 103, g: 32, b: 255 });

export { BRAND };
