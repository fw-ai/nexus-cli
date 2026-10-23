/** Banner-only truecolor theme (ansis). Command output uses style.mjs + palette.mjs. */
import { Ansis } from "ansis";

import { isColorEnabled, terminalTheme } from "./color.mjs";
import { CLI_COLORS, LOGO_GRADIENT } from "./tokens.mjs";

/**
 * We already decide on/off ourselves via `isColorEnabled(stream)` below, so
 * force this instance to truecolor (level 3) rather than letting ansis
 * re-detect support from `process.stdout`/env -- keeps a single source of
 * truth for the enable/disable decision and guarantees exact brand hex
 * values instead of a downsampled approximation.
 *
 * ansis (unlike picocolors) also tracks nested styles: wrapping one style's
 * output inside another correctly re-opens the outer color after the inner
 * one resets, instead of falling back to the terminal default.
 */
const ansi = new Ansis(3);

/**
 * Color at `position` (0 = left edge, 1 = right edge) along the logo gradient.
 * @param {number} position
 * @returns {string} `#RRGGBB`
 */
export function logoGradientAt(position) {
  const t = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0)) * (LOGO_GRADIENT.length - 1);
  const index = Math.min(LOGO_GRADIENT.length - 2, Math.floor(t));
  const local = t - index;
  const [from, to] = [LOGO_GRADIENT[index], LOGO_GRADIENT[index + 1]].map((hex) => Number.parseInt(hex.slice(1), 16));
  const channel = (shift) => Math.round((((from >> shift) & 255) * (1 - local)) + (((to >> shift) & 255) * local));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/**
 * @param {NodeJS.WriteStream | { isTTY?: boolean }} [stream]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function createTheme(stream = process.stdout, env = process.env) {
  const color = isColorEnabled(stream);

  if (!color) {
    const plain = (text) => text;
    return {
      color: false,
      muted: plain,
      interactive: plain,
      success: plain,
      warn: plain,
      error: plain,
      heading: plain,
      logo: () => plain,
      symbols: {
        success: "*",
        warn: "!",
        error: "x",
        info: ">",
      },
    };
  }

  const cli = CLI_COLORS[terminalTheme(env)];
  return {
    color: true,
    muted: ansi.dim,
    interactive: ansi.hex(cli.accent),
    success: ansi.hex(cli.primary),
    warn: ansi.yellow,
    error: ansi.red,
    heading: ansi.bold,
    /** @param {number} position 0..1 across the banner */
    logo: (position) => ansi.hex(logoGradientAt(position)),
    symbols: {
      success: "\u2713",
      warn: "!",
      error: "\u2717",
      info: "\u2192",
    },
  };
}
