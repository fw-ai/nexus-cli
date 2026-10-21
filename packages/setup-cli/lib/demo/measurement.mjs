/**
 * Measurement and cost math for `nexus demo` (§6 of the brief).
 *
 * Everything here is pure and deterministic so the math can be unit-tested and
 * audited. Display rounding is applied only at format time; internal values and
 * the JSON result keep full precision.
 */

/**
 * Cost in USD for one provider run.
 *   cost = (input_tokens / 1e6) * in_rate
 *        + (cache_write_1h / 1e6) * write_1h_rate
 *        + (cache_write_5m / 1e6) * write_5m_rate
 *        + (cache_read / 1e6) * read_rate
 *        + (output_tokens / 1e6) * out_rate
 * Rates are USD per 1M tokens. Anthropic prompt-caching bills cache WRITES at a
 * premium over base input (differing by 1h/5m TTL) and cache READS at a steep
 * discount; real Anthropic runs cache most of the system+prompt, so usage.
 * input_tokens is just the uncached remainder. Pricing all cached tokens at the
 * cheap read rate (or ignoring them) understates cost; each bucket needs its
 * own rate. Fireworks serverless models don't bill cache writes, so their write
 * rate is 0 and only the read bucket (if any) contributes.
 *
 * @param {{ inputTokens: number, cacheWrite1hTokens?: number, cacheWrite5mTokens?: number, cacheReadTokens?: number, outputTokens: number, inputPerMillion: number, cacheWrite1hPerMillion?: number, cacheWrite5mPerMillion?: number, cacheReadPerMillion?: number, outputPerMillion: number }} run
 * @returns {number}
 */
export function runCost({
  inputTokens,
  cacheWrite1hTokens = 0,
  cacheWrite5mTokens = 0,
  cacheReadTokens = 0,
  outputTokens,
  inputPerMillion,
  cacheWrite1hPerMillion = 0,
  cacheWrite5mPerMillion = 0,
  cacheReadPerMillion = 0,
  outputPerMillion,
}) {
  return (
    (num(inputTokens) / 1e6) * num(inputPerMillion)
    + (num(cacheWrite1hTokens) / 1e6) * num(cacheWrite1hPerMillion)
    + (num(cacheWrite5mTokens) / 1e6) * num(cacheWrite5mPerMillion)
    + (num(cacheReadTokens) / 1e6) * num(cacheReadPerMillion)
    + (num(outputTokens) / 1e6) * num(outputPerMillion)
  );
}

/**
 * Speed ratio: how many times faster the challenger (Fireworks) was than the
 * incumbent. >1 means Fireworks was faster. Uses wall-clock seconds.
 *
 * @param {{ incumbentSeconds: number, fireworksSeconds: number }} args
 * @returns {number}
 */
export function speedRatio({ incumbentSeconds, fireworksSeconds }) {
  const inc = num(incumbentSeconds);
  const fw = num(fireworksSeconds);
  if (fw <= 0) {
    return 0;
  }
  return inc / fw;
}

/**
 * Fraction of cost saved by using Fireworks instead of the incumbent.
 *   1 - (fireworks_cost / incumbent_cost)
 * Returns a fraction (0.5 == 50% cheaper). >0 means Fireworks was cheaper.
 *
 * @param {{ incumbentCost: number | null, fireworksCost: number | null }} args
 * @returns {number}
 */
export function costSavedFraction({ incumbentCost, fireworksCost }) {
  if (!Number.isFinite(incumbentCost) || !Number.isFinite(fireworksCost)) {
    return Number.NaN;
  }
  const inc = incumbentCost;
  const fw = fireworksCost;
  if (inc <= 0) {
    return 0;
  }
  return 1 - fw / inc;
}

/**
 * Linear extrapolation: cost per N generations (default 1000). Clearly linear;
 * the caller labels it as such.
 *
 * @param {{ cost: number | null, generations?: number }} args
 * @returns {number | null}
 */
export function costPerGenerations({ cost, generations = 1000 }) {
  if (!Number.isFinite(cost)) {
    return null;
  }
  return num(cost) * num(generations);
}

/**
 * Compose a full result object from two measured provider runs. This is the
 * single source of truth for what goes into result.json and --json.
 *
 * @param {{
 *   incumbent: ProviderRun,
 *   fireworks: ProviderRun,
 *   prompt: { title: string, text: string, presetId?: string, source: string },
 *   mode: "harness-swap",
 * }} args
 * @returns {DemoResult}
 *
 * @typedef {Object} ProviderRun
 * @property {string} side "incumbent" | "fireworks"
 * @property {string} provider e.g. "Anthropic", "Fireworks"
 * @property {string} model e.g. "claude-sonnet-5", "glm-5p2-fast"
 * @property {string} modelId fully-qualified id where applicable
 * @property {"live"} callMode
 * @property {number} inputTokens
 * @property {number} cacheWrite1hTokens 1h prompt-cache write tokens
 * @property {number} cacheWrite5mTokens 5m prompt-cache write tokens
 * @property {number} cacheReadTokens prompt-cache read/hit tokens
 * @property {number} outputTokens
 * @property {number} seconds wall-clock request-sent -> stream-complete
 * @property {number | null} cost USD, or null when no real rate is available
 * @property {{ inputPerMillion: number, outputPerMillion: number, cachedInputPerMillion?: number, cacheWrite1hPerMillion?: number, cacheWrite5mPerMillion?: number, cacheReadPerMillion?: number, tier?: string, source: string }} rates
 * @property {boolean} ok whether generation succeeded
 * @property {string} [error] failure message when !ok
 * @property {boolean} [appRunnable] whether the extracted HTML is parseable
 *
 * @typedef {Object} DemoResult
 * @property {string} promptTitle
 * @property {string} promptText
 * @property {string} promptSource
 * @property {string} [presetId]
 * @property {"harness-swap"} mode
 * @property {{ speedRatio: number, costSavedFraction: number, incumbentFaster: boolean, fireworksCheaper: boolean }} summary
 * @property {ProviderRun} incumbent
 * @property {ProviderRun} fireworks
 * @property {string} createdAt ISO timestamp (set by caller; this module is pure)
 */
export function buildResult({ incumbent, fireworks, prompt, mode }) {
  const ratio = speedRatio({
    incumbentSeconds: incumbent.seconds,
    fireworksSeconds: fireworks.seconds,
  });
  const saved = costSavedFraction({
    incumbentCost: incumbent.cost,
    fireworksCost: fireworks.cost,
  });
  return {
    promptTitle: prompt.title,
    promptText: prompt.text,
    promptSource: prompt.source,
    presetId: prompt.presetId,
    mode,
    summary: {
      speedRatio: ratio,
      costSavedFraction: saved,
      incumbentFaster: ratio < 1,
      fireworksCheaper: saved > 0,
    },
    incumbent,
    fireworks,
    createdAt: "",
  };
}

// ── display formatting (display-only rounding) ──────────────────────────────

/** @param {number} value @returns {string} e.g. "3.1×" */
export function formatSpeedRatio(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }
  return `${round1(value)}×`;
}

/** @param {number} fraction 0..1 @returns {string} e.g. "73% cheaper" or "12% more expensive" */
export function formatCostDelta(fraction) {
  if (!Number.isFinite(fraction)) {
    return "—";
  }
  const pct = Math.round(fraction * 100);
  if (pct === 0) {
    return "same cost";
  }
  return pct > 0 ? `${pct}% cheaper` : `${Math.abs(pct)}% more expensive`;
}

/** @param {number} usd @returns {string} e.g. "$0.0061" */
export function formatUsd(usd) {
  if (!Number.isFinite(usd)) {
    return "—";
  }
  if (usd === 0) {
    return "$0";
  }
  // up to 4 decimal places, trailing zeros trimmed
  let s = usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (s === "0") {
    // Positive but rounds to $0 at 4 decimals — show a floor so the meter
    // doesn't read "$0" while a side is actively generating.
    return "<$0.0001";
  }
  if (!s.startsWith("$")) {
    s = `$${s}`;
  }
  return s;
}

/** @param {number} seconds @returns {string} e.g. "3.1s" */
export function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  return `${round1(seconds)}s`;
}

/** @param {number} tokens @returns {string} e.g. "2,210" */
export function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return "—";
  }
  return Math.round(tokens).toLocaleString("en-US");
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}
