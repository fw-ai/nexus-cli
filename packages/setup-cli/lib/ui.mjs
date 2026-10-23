import process from "node:process";

import { withSpinner } from "./ui/spinner.mjs";
import { bold, isStyleEnabled } from "./ui/style.mjs";

export {
  _setColorEnabled,
  accent,
  bold,
  check,
  dim,
  fail,
  isStyleEnabled,
  muted,
  ok,
  paint,
  primary,
  red,
  symbols,
  warn,
  yellow,
  yesNo,
} from "./ui/style.mjs";

export { colorsEnabled, isColorEnabled, isInteractiveColorEnabled } from "./ui/color.mjs";
export { ANSI, METER } from "./ui/palette.mjs";
export { sanitize } from "./ui/sanitize.mjs";
export { withSpinner };

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist = Array.from({ length: rows }, (_, i) => {
    const row = new Array(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) {
    dist[0][j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1,
        dist[i][j - 1] + 1,
        dist[i - 1][j - 1] + cost,
      );
    }
  }
  return dist[rows - 1][cols - 1];
}

/**
 * Nearest candidate by edit distance, or "" when nothing is plausibly close.
 * @param {string} input
 * @param {Iterable<string>} candidates
 */
export function closestMatch(input, candidates) {
  const needle = input.toLowerCase();
  let best = "";
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Flags share a long `--` prefix, so a broad string-distance threshold can
  // produce nonsense suggestions (`--slot` → `--json`). Keep flag matching
  // strict while retaining the more forgiving command-name behavior.
  const threshold = input.startsWith("--")
    ? 2
    : Math.max(1, Math.floor(input.length / 2));
  return bestDistance <= threshold ? best : "";
}

/**
 * @param {string} message
 * @param {string} input
 * @param {Iterable<string>} candidates
 */
export function withSuggestion(message, input, candidates) {
  const suggestion = closestMatch(input, candidates);
  return suggestion ? `${message} Did you mean: ${suggestion}?` : message;
}

/**
 * Colorize a block of plain help text without changing its layout.
 * @param {string} text
 */
export function colorizeHelp(text) {
  if (!isStyleEnabled()) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => {
      if (/^[A-Z][^:]*:$/.test(line)) {
        return bold(line);
      }
      const match = line.match(/^(\s{2,})(--?[\w-]+(?:, --?[\w-]+)*|\S+)(.*)$/);
      if (match && !line.trimStart().startsWith("#")) {
        return `${match[1]}${bold(match[2])}${match[3]}`;
      }
      return line;
    })
    .join("\n");
}
