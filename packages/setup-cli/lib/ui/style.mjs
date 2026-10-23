import process from "node:process";

import { colorsEnabled } from "./color.mjs";
import { ANSI } from "./palette.mjs";

let enabled = colorsEnabled();

/** Whether styling is currently active (test hook + help coloring). */
export function isStyleEnabled() {
  return enabled;
}

/** Test hook: force styling on/off regardless of the ambient terminal. */
export function _setColorEnabled(value) {
  enabled = Boolean(value);
}

function wrap(open, close) {
  return (text) => (enabled ? `${open}${text}${close}` : String(text));
}

export const bold = wrap(ANSI.bold, "[22m");
export const dim = wrap(ANSI.dimFaint, "[22m");
export const muted = wrap(ANSI.muted, "[39m");
export const red = wrap(ANSI.red, "[39m");
export const yellow = wrap(ANSI.yellow, "[39m");

function styled(open, text, stream) {
  const useColor = stream === undefined
    ? enabled
    : colorsEnabled(stream);
  return useColor ? `${open}${text}[39m` : String(text);
}

/**
 * Accent: only what the user can type or open (commands, URLs, choices).
 */
export function accent(text, stream = undefined) {
  return styled(ANSI.accent, text, stream);
}

/**
 * Primary: `✓` and the one key message per output.
 */
export function primary(text, stream = undefined) {
  return styled(ANSI.primary, text, stream);
}

function unicodeOk(env = process.env) {
  if (process.platform === "win32") {
    return false;
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(locale);
}

const glyphs = unicodeOk()
  ? { ok: "✓", fail: "✗", warn: "!", bullet: "•", pointer: "❯" }
  : { ok: "ok", fail: "x", warn: "!", bullet: "*", pointer: ">" };

export const symbols = Object.freeze(glyphs);

export function ok(message) {
  return `${primary(symbols.ok)} ${message}`;
}

export function fail(message) {
  return `${red(symbols.fail)} ${message}`;
}

export function warn(message) {
  return `${yellow(symbols.warn)} ${message}`;
}

export function yesNo(value) {
  return value ? "yes" : red("no");
}

/** Primary "✓" success glyph (login/status). */
export function check(stream = process.stdout) {
  return (enabled || colorsEnabled(stream)) ? `${ANSI.primary}${symbols.ok}[39m` : symbols.ok;
}

/**
 * Paint raw ANSI when color is enabled on `stream`.
 * @param {string} openSeq
 * @param {string} text
 * @param {{ isTTY?: boolean }} [stream]
 */
export function paint(openSeq, text, stream = process.stdout) {
  return colorsEnabled(stream) ? `${openSeq}${text}${ANSI.reset}` : text;
}
