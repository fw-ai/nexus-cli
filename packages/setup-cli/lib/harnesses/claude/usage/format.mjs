/**
 * Shared cost / cache formatting for the live meter and session/agent pickers.
 * Matches the meter’s cost columns and cache-hit share.
 */

import { UNPRICED_TEXT } from "./cost.mjs";

/**
 * Digits for a cost, without a currency sign: always four decimals.
 *
 * Two decimals is the wrong scale for this product. At Fireworks rates a whole
 * session is routinely worth less than a cent, so the digits that carry the
 * information sit past the cents column: $0.006891 quoted as `$0.01` is 45%
 * high, and $0.075436 as `$0.08` is 6% high. Four decimals hold the error under
 * a hundredth of a cent at every magnitude, and the fixed width keeps a column
 * of costs aligned without any trimming rules.
 *
 * Three outcomes are deliberately distinct, because they mean different things:
 * exactly `0` is free and reads `0` with no decimals to imply a measurement;
 * a positive amount too small for four decimals reads as an exponent
 * (`4.0e-5`), never `0`, because that call did cost something; everything else
 * reads at four decimals.
 *
 * @param {number} cost
 * @returns {string}
 */
export function usageCostDigits(cost) {
  if (cost <= 0) return "0";
  return cost < 0.0001 ? cost.toExponential(1) : cost.toFixed(4);
}

/**
 * A cost with its currency sign — one call, one model, or a whole session.
 *
 * One function for all three on purpose: a single-call session's total has to
 * read exactly like the call it sums, and the live meter, the status line, the
 * pickers and the `claude usage` report all quote the same figures. Splitting
 * "per call" from "per total" is what let those surfaces disagree, with the
 * report printing $0.0069 where the status line printed $0.01.
 *
 * `null` means no rate could be looked up. That reads `n/a`, never `$0`: a call
 * we cannot price is not a free call. A free call is `$0`, matching the demo's
 * `formatUsd`.
 *
 * @param {number | null} cost
 * @returns {string}
 */
export function formatUsageCost(cost) {
  if (cost == null) return UNPRICED_TEXT;
  const n = Number(cost);
  if (!Number.isFinite(n)) return "$0";
  return `$${usageCostDigits(n)}`;
}

/**
 * Cache-hit ratio of prompt tokens, or null when there is no prompt.
 *
 * @param {{
 *   input?: number,
 *   cacheRead?: number,
 *   cacheWrite?: number,
 *   cacheWrite5m?: number,
 *   cacheWrite1h?: number,
 * }} totals
 * @returns {number | null}
 */
export function usageCacheHitRatio(totals = {}) {
  const input = Number(totals.input) || 0;
  const cacheRead = Number(totals.cacheRead) || 0;
  const cacheWrite = Number.isFinite(Number(totals.cacheWrite))
    ? Number(totals.cacheWrite)
    : (Number(totals.cacheWrite5m) || 0) + (Number(totals.cacheWrite1h) || 0);
  const prompt = input + cacheRead + cacheWrite;
  if (prompt <= 0) return null;
  return cacheRead / prompt;
}

/**
 * Round a cache-hit ratio to whole percent WITHOUT inventing 0% or 100%.
 *
 * `Math.round` alone reports a false perfect hit: a turn with 81 fresh tokens
 * against 21.7M cached is 99.85%, which rounds to "100%" and claims nothing was
 * billed at the full prompt rate — while those fresh tokens plus 31.9k cache
 * writes were charged. The reverse end lies the same way, printing "0%" for a
 * cache that did return tokens.
 *
 * So 100% is reserved for `cacheRead === prompt` and 0% for `cacheRead === 0`;
 * everything strictly between clamps to 1..99. The rounding error is at most one
 * percentage point, but the claim "perfectly cached" is qualitatively different
 * from "almost perfectly cached" when the number exists to explain a bill.
 *
 * @param {number} ratio 0..1
 * @returns {number} whole percent, 0..100
 */
export function roundCachePct(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= 1) return 100;
  return Math.min(99, Math.max(1, Math.round(ratio * 100)));
}

/**
 * Cache-hit share as a display string (e.g. `90%`, or `—` when unknown).
 *
 * @param {{
 *   input?: number,
 *   cacheRead?: number,
 *   cacheWrite?: number,
 *   cacheWrite5m?: number,
 *   cacheWrite1h?: number,
 * }} totals
 */
export function formatUsageCachePct(totals = {}) {
  const ratio = usageCacheHitRatio(totals);
  if (ratio == null) return "—";
  return `${roundCachePct(ratio)}%`;
}
