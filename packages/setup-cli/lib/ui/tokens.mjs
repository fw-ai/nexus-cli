/**
 * Nexus CLI color guide. Primary marks `✓` and the one key message per
 * output; accent marks only what the user can type or open (commands, URLs,
 * choices). Everything else uses the terminal's default color.
 */
export const CLI_COLORS = Object.freeze({
  dark: Object.freeze({ primary: "#FC7293", accent: "#F0ACD6" }),
  light: Object.freeze({ primary: "#BF1153", accent: "#A71E7E" }),
});

/**
 * Design System V2 data colors for charts, tables, and per-series marks. Not
 * for prose or interface chrome. The palette's two purples (#9888F5, #715FD8)
 * are replaced by the CLI color guide's logo-gradient stops `amber` and `flare`.
 */
export const DATA_COLORS = Object.freeze({
  teal: "#31D4D3",
  green: "#5DB48E",
  coral: "#FF7C57",
  rose: "#C3519B",
  peach: "#FAC193",
  deepGreen: "#05896C",
  blush: "#F9ADB1",
  sky: "#C3E4FB",
  amber: "#D97547",
  flare: "#DE4A7D",
});

/** Install screen only. */
export const LOGO_GRADIENT = Object.freeze(["#D97547", "#DE4A7D", "#D361AD", "#D494BB"]);

/** Semantic terminal roles — mapped in theme.mjs to ANSI slots, not hex literals. */
export const SEMANTIC = {
  interactive: "accent",
  success: "primary",
  muted: "muted",
  spend: "data",
};
