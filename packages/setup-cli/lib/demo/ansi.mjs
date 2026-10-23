/**
 * Minimal raw-ANSI escape helpers for the demo split-pane TUI.
 * Shares the canonical palette with the rest of the CLI.
 */

import process from "node:process";
import { ANSI } from "../ui/palette.mjs";

export const ESC = "\x1b[";
export const RESET = ANSI.reset;
export const BOLD = ANSI.bold;
/** Color guide: `✓` and the one key message. */
export const PRIMARY = ANSI.primary;
/** Color guide: only what the user can type or open (keys, URLs, choices). */
export const ACCENT = ANSI.accent;
export const YELLOW = ANSI.yellow;
export const RED = ANSI.red;
export const REVERSE = `${ESC}7m`;

function detectDarkBg() {
  const fgbg = process.env.COLORFGBG ?? "";
  const parts = fgbg.split(";");
  const bg = parts.length === 2 ? Number(parts[1]) : NaN;
  return bg === 0 || bg === 8;
}

export const DIM = detectDarkBg() ? ANSI.dimFaint : ANSI.muted;

export const HIDE_CURSOR = ANSI.hideCursor;
export const SHOW_CURSOR = ANSI.showCursor;
export const SAVE_CURSOR = `${ESC}s`;
export const RESTORE_CURSOR = `${ESC}u`;
export const CLEAR_SCREEN = ANSI.clearScreen;
export const HOME_CURSOR = ANSI.homeCursor;

/** Move cursor to row, col (1-indexed). */
export function moveTo(row, col) {
  return `${ESC}${row};${col}H`;
}

export const CLEAR_LINE = ANSI.clearLine;
export const CLEAR_FULL_LINE = `\r${CLEAR_LINE}`;

/**
 * @param {string} s
 * @returns {string}
 */
export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/**
 * @param {string} s
 * @returns {number}
 */
export function visibleWidth(s) {
  return stripAnsi(s).length;
}

/**
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
export function truncateVisible(s, width) {
  const stripped = stripAnsi(s);
  if (stripped.length <= width) {
    return s;
  }
  return `${stripped.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
export function padRight(s, width) {
  const stripped = stripAnsi(s);
  if (stripped.length >= width) {
    return s;
  }
  return `${s}${" ".repeat(width - stripped.length)}`;
}

/**
 * @param {number} filled
 * @param {number} total
 * @param {number} width
 * @returns {string}
 */
export function progressBar(filled, total, width) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, filled / total)) : 0;
  const cells = Math.round(ratio * width);
  return `${"▓".repeat(cells)}${"░".repeat(Math.max(0, width - cells))}`;
}
