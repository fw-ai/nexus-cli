import test from "node:test";
import assert from "node:assert/strict";
import { resolvePrompt, DEMO_PRESETS, DEFAULT_DEMO_PRESET } from "../../lib/demo/presets.mjs";
import {
  runCost,
  speedRatio,
  costSavedFraction,
  costPerGenerations,
  buildResult,
  formatSpeedRatio,
  formatCostDelta,
  formatUsd,
  formatSeconds,
  formatTokens,
} from "../../lib/demo/measurement.mjs";
import { extractHtml, looksRunnable } from "../../lib/demo/html-extract.mjs";
import { parseCli } from "../../lib/cli/parse-args.mjs";

// ── presets ────────────────────────────────────────────────────────────────

test("presets: default is tetris and contains the HTML-only suffix", () => {
  assert.equal(DEFAULT_DEMO_PRESET, "tetris");
  const t = DEMO_PRESETS.tetris.prompt;
  assert.match(t, /Tetris/i);
  assert.match(t, /Return only a single complete HTML file/);
});

test("presets: each preset ends with the no-fence instruction", () => {
  for (const preset of Object.values(DEMO_PRESETS)) {
    assert.match(preset.prompt, /No explanation, no markdown fences\.$/);
  }
});

test("resolvePrompt: promptFile wins over preset", async () => {
  const result = await resolvePrompt({
    prompt: "tetris",
    promptFile: "/tmp/x.txt",
    readFile: async () => "build a thing",
  });
  assert.equal(result.source, "file");
  assert.equal(result.rawPrompt, "build a thing");
  assert.match(result.prompt, /^build a thing/);
  assert.match(result.prompt, /Return only a single complete HTML file/);
});

test("resolvePrompt: preset id resolves to canned text", async () => {
  const result = await resolvePrompt({ prompt: "snake" });
  assert.equal(result.source, "preset");
  assert.equal(result.presetId, "snake");
  assert.equal(result.prompt, DEMO_PRESETS.snake.prompt);
});

test("resolvePrompt: unknown string is treated as a literal prompt", async () => {
  const result = await resolvePrompt({ prompt: "build me a calculator" });
  assert.equal(result.source, "literal");
  assert.equal(result.rawPrompt, "build me a calculator");
  assert.match(result.prompt, /^build me a calculator/);
  assert.match(result.prompt, /Return only a single complete HTML file/);
  assert.match(result.prompt, /No explanation, no markdown fences\.$/);
});

test("resolvePrompt: custom sentinel requires a real task", async () => {
  await assert.rejects(
    () => resolvePrompt({ prompt: "custom" }),
    /requires --prompt/,
  );
});

test("resolvePrompt: custom channel treats a literal 'custom' task as a real prompt", async () => {
  const result = await resolvePrompt({ custom: "custom" });
  assert.equal(result.source, "literal");
  assert.equal(result.rawPrompt, "custom");
  assert.match(result.prompt, /^custom/);
  assert.match(result.prompt, /Return only a single complete HTML file/);
});

test("resolvePrompt: custom channel wins over prompt/preset interpretation", async () => {
  const result = await resolvePrompt({ prompt: "snake", custom: "build a maze" });
  assert.equal(result.source, "literal");
  assert.equal(result.rawPrompt, "build a maze");
});

test("resolvePrompt: default preset when nothing passed", async () => {
  const result = await resolvePrompt({});
  assert.equal(result.presetId, DEFAULT_DEMO_PRESET);
});

test("resolvePrompt: empty prompt file throws", async () => {
  await assert.rejects(
    () => resolvePrompt({ promptFile: "/tmp/empty.txt", readFile: async () => "   " }),
    /empty/i,
  );
});

// ── measurement ─────────────────────────────────────────────────────────────

test("runCost: input + output at per-Mtok rates", () => {
  // 1000 in @ $3/Mtok = $0.003 ; 2000 out @ $15/Mtok = $0.030 → $0.033
  assert.equal(
    runCost({ inputTokens: 1000, outputTokens: 2000, inputPerMillion: 3, outputPerMillion: 15 }),
    0.033,
  );
});

test("runCost: zero tokens is zero cost", () => {
  assert.equal(runCost({ inputTokens: 0, outputTokens: 0, inputPerMillion: 3, outputPerMillion: 15 }), 0);
});

test("runCost: prompt-cache writes billed at the write rate, reads at the read rate", () => {
  // Real Anthropic runs cache most of the prompt via a 1h cache WRITE (billed at
  // a premium over base input, e.g. $10/M for Opus vs $5 base) — NOT at the cheap
  // cache-read rate. Pricing writes at the read rate (or ignoring them) understates
  // cost and inverts the comparison. 2 in @ $5 + 87990 1h-write @ $10 + 2205 out @ $25.
  assert.equal(
    runCost({
      inputTokens: 2,
      cacheWrite1hTokens: 87990,
      cacheReadTokens: 0,
      outputTokens: 2205,
      inputPerMillion: 5,
      cacheWrite1hPerMillion: 10,
      cacheReadPerMillion: 0.5,
      outputPerMillion: 25,
    }),
    0.935035,
  );
  // Cache reads (hits) ARE billed at the cheap read rate.
  assert.equal(
    runCost({
      inputTokens: 0,
      cacheReadTokens: 100000,
      outputTokens: 0,
      inputPerMillion: 5,
      cacheReadPerMillion: 0.5,
      outputPerMillion: 25,
    }),
    0.05,
  );
  // Omitting the cache buckets (old behavior) would yield 0.055135 — wrong.
  assert.notEqual(
    runCost({ inputTokens: 2, outputTokens: 2205, inputPerMillion: 5, outputPerMillion: 25 }),
    0.935035,
  );
});

test("runCost: omitted cache fields default to 0 (back-compat with uncached runs)", () => {
  assert.equal(
    runCost({ inputTokens: 1000, outputTokens: 2000, inputPerMillion: 3, outputPerMillion: 15 }),
    0.033,
  );
});

test("speedRatio: incumbent 2x slower than fireworks", () => {
  assert.equal(speedRatio({ incumbentSeconds: 6, fireworksSeconds: 3 }), 2);
});

test("speedRatio: zero fireworks time degrades to 0 (honest, no div-by-zero)", () => {
  assert.equal(speedRatio({ incumbentSeconds: 6, fireworksSeconds: 0 }), 0);
});

test("costSavedFraction: fireworks at half the cost saves 50%", () => {
  assert.equal(costSavedFraction({ incumbentCost: 0.10, fireworksCost: 0.05 }), 0.5);
});

test("costSavedFraction: fireworks more expensive yields negative (honestly)", () => {
  assert.equal(costSavedFraction({ incumbentCost: 0.05, fireworksCost: 0.10 }), -1);
});

test("costSavedFraction: unavailable cost is not comparable", () => {
  assert.equal(
    Number.isNaN(costSavedFraction({ incumbentCost: 0.05, fireworksCost: null })),
    true,
  );
});

test("costPerGenerations: linear extrapolation", () => {
  assert.equal(costPerGenerations({ cost: 0.01, generations: 1000 }), 10);
});

test("costPerGenerations: unavailable cost stays unavailable", () => {
  assert.equal(costPerGenerations({ cost: null, generations: 1000 }), null);
});

test("buildResult: summary flags driven by real numbers", () => {
  const result = buildResult({
    incumbent: { seconds: 8, cost: 0.05, ok: true },
    fireworks: { seconds: 2, cost: 0.01, ok: true },
    prompt: { title: "Tetris", text: "x", source: "preset" },
    mode: "key-race",
  });
  assert.equal(result.summary.speedRatio, 4);
  assert.equal(result.summary.costSavedFraction, 0.8);
  assert.equal(result.summary.incumbentFaster, false);
  assert.equal(result.summary.fireworksCheaper, true);
  assert.equal(result.mode, "key-race");
  assert.ok(!("seed" in result));
});

test("buildResult: when incumbent is actually faster, flags say so", () => {
  const result = buildResult({
    incumbent: { seconds: 2, cost: 0.01, ok: true },
    fireworks: { seconds: 8, cost: 0.05, ok: true },
    prompt: { title: "x", text: "x", source: "literal" },
    mode: "harness-swap",
  });
  assert.equal(result.summary.speedRatio, 0.25);
  assert.equal(result.summary.incumbentFaster, true);
  assert.equal(result.summary.fireworksCheaper, false);
});

// ── formatting (display-only rounding) ───────────────────────────────────────

test("formatSpeedRatio", () => {
  assert.equal(formatSpeedRatio(3.14), "3.1×");
  assert.equal(formatSpeedRatio(0), "—");
});

test("formatCostDelta: cheaper / more expensive / same", () => {
  assert.equal(formatCostDelta(0.5), "50% cheaper");
  assert.equal(formatCostDelta(-0.1), "10% more expensive");
  // 0.1% rounds to 0% → displayed as "same cost" (display rounding, honest).
  assert.equal(formatCostDelta(0.001), "same cost");
  assert.equal(formatCostDelta(0), "same cost");
});

test("formatUsd trims trailing zeros", () => {
  assert.equal(formatUsd(0.0061), "$0.0061");
  assert.equal(formatUsd(0.01), "$0.01");
  assert.equal(formatUsd(0), "$0");
});

test("formatSeconds and formatTokens", () => {
  assert.equal(formatSeconds(3.14), "3.1s");
  assert.equal(formatTokens(2210), "2,210");
});

// ── html extraction ─────────────────────────────────────────────────────────

test("extractHtml: passes through clean HTML", () => {
  const html = "<!doctype html><html><body><p>hi</p></body></html>";
  const r = extractHtml(html);
  assert.equal(r.ok, true);
  assert.equal(r.html, html);
});

test("extractHtml: strips ```html fences", () => {
  const raw = "Here you go:\n```html\n<!doctype html><html><body>hi</body></html>\n```\n";
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, "<!doctype html><html><body>hi</body></html>");
});

test("extractHtml: trims leading prose up to <html>", () => {
  const raw = "Sure! Here's the file:\n<html><body><canvas/></body></html>\nthanks!";
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.match(r.html, /^<html>/);
  assert.match(r.html, /<\/html>$/);
});

test("extractHtml: empty input is not ok", () => {
  assert.equal(extractHtml("").ok, false);
  assert.equal(extractHtml("   ").ok, false);
});

test("extractHtml: plain prose with no tags is not ok", () => {
  const r = extractHtml("I can't help with that.");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no html/i);
});

test("looksRunnable", () => {
  assert.equal(looksRunnable("<html><script>x</script></html>"), true);
  assert.equal(looksRunnable("just text"), false);
});

// Real-world failure: a model roleplays a Write tool call — escaped HTML inside
// a JSON object, plus a leaked antml:thinking prefix before the real copy.
test("extractHtml: recovers HTML from roleplayed JSON tool call", () => {
  const clean = '<!DOCTYPE html>\n<html lang="en">\n<body><p>ok</p>\n</body>\n</html>';
  const escaped = clean.replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const raw =
    "**Write**\n\n````\n{\n  \"file_path\": \"/tmp/clock.html\",\n" +
    "  \"content\": \"" + escaped + "\"\n}\n````\n\n" +
    "antml:thinking Now output the HTML content only." + clean;
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, clean);
  assert.ok(!r.html.includes('\\"'), "must not contain escaped quotes");
  assert.ok(!r.html.includes("\\n"), "must not contain literal \\n sequences");
});

// A model may wrap the JSON tool call in a ````-length fence to dodge the
// "no markdown fences" instruction. The fence stripper must handle it.
test("extractHtml: strips quad-backtick fences", () => {
  const html = "<!doctype html><html><body>hi</body></html>";
  const raw = "````\n" + html + "\n````";
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, html);
});

// A garbage fence must not hide a real document that follows it.
test("extractHtml: falls back past an unrecoverable fence", () => {
  const html = "<!doctype html><html><body>hi</body></html>";
  const raw = "```\nnot html at all\n```\nSure — here it is:\n" + html;
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, html);
});

// When the document appears twice (escaped copy + real copy), the cleanest
// copy must win — the escaped one scores high on artifact count.
test("extractHtml: picks the cleanest of duplicate document copies", () => {
  const clean = "<!doctype html>\n<html>\n<body><script>var x = 1;</script></body>\n</html>";
  const escaped = clean.replace(/\n/g, "\\n").replace(/"/g, '\\"');
  const raw = "{ \"content\": \"" + escaped + "\" }\n\n" + clean;
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, clean);
});

// A malformed JSON tool call (unescaped, trailing garbage) must not break
// extraction: copy scoring still recovers the real HTML.
test("extractHtml: survives malformed JSON wrapper with duplicate copies", () => {
  const clean = "<!doctype html>\n<html>\n<body>clock</body>\n</html>";
  const escaped = clean.replace(/\n/g, "\\n");
  const raw = "Write\n{ \"content\": \"" + escaped + "\" more junk\n\n" + clean;
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, clean);
});

// The roleplayed JSON may sit in surrounding prose rather than alone.
test("extractHtml: recovers JSON tool call preceded by prose", () => {
  const clean = "<!doctype html>\n<html>\n<body>hi</body>\n</html>";
  const escaped = clean.replace(/\n/g, "\\n").replace(/"/g, '\\"');
  const raw = "Write tool call: {\"content\": \"" + escaped + "\"}";
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, clean);
});

// A truncated document in a fence must not shadow the complete document that
// follows it outside the fence (the fragment borrows the real close tag).
test("extractHtml: truncated fenced copy loses to complete doc after it", () => {
  const full = "<!doctype html>\n<html>\n<body>full version</body>\n</html>";
  const raw = "```html\n<!doctype html><html><body>trunc\n```\nsorry, full version:\n" + full;
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, full);
});

// Malformed JSON inside a fence must not shadow a clean document that follows:
// copy ranking on the fence body alone can treat the escaped copy as complete.
test("extractHtml: malformed fenced JSON loses to clean doc after fence", () => {
  const clean = "<!doctype html>\n<html>\n<body>clock</body>\n</html>";
  const escaped = clean.replace(/\n/g, "\\n").replace(/"/g, '\\"');
  const raw = "````\n{ \"content\": \"" + escaped + "\" more junk\n````\n\n" + clean;
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, clean);
  assert.ok(!r.html.includes("\\n"), "must not contain literal \\n sequences");
});

test("extractHtml: keeps jsonHtml-unescaped fenced doc over escaped whole copy", () => {
  // Legitimate JS can contain `\\` (artifactScore > 0) after jsonHtml unescapes.
  const clean = "<!doctype html>\n<html>\n<body><script>var s = '\\\\';</script></body>\n</html>";
  const escaped = clean.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
  const raw = "````\n{\"content\": \"" + escaped + "\"}\n````";
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, clean);
});

// ── parse-args: claude demo command ───────────────────────────────────────────

test("parseCli: claude demo with positional preset folds into ctx.prompt", () => {
  const parsed = parseCli(["claude", "demo", "snake"]);
  assert.equal(parsed.kind, "demo");
  assert.equal(parsed.deprecated, false);
  assert.equal(parsed.ctx.prompt, "snake");
});

test("parseCli: deprecated top-level demo still parses with deprecated flag", () => {
  const parsed = parseCli(["demo", "snake"]);
  assert.equal(parsed.kind, "demo");
  assert.equal(parsed.deprecated, true);
  assert.equal(parsed.ctx.prompt, "snake");
});

test("parseCli: claude demo custom is accepted as the fifth prompt option", () => {
  const parsed = parseCli(["claude", "demo", "custom"]);
  assert.equal(parsed.kind, "demo");
  assert.equal(parsed.ctx.prompt, "custom");
});

test("parseCli: claude demo --prompt flag", () => {
  const parsed = parseCli(["claude", "demo", "--prompt", "clock"]);
  assert.equal(parsed.kind, "demo");
  assert.equal(parsed.ctx.prompt, "clock");
});

test("parseCli: explicit --prompt wins over positional preset", () => {
  const parsed = parseCli(["claude", "demo", "tetris", "--prompt", "snake"]);
  assert.equal(parsed.ctx.prompt, "snake");
});

test("parseCli: unknown preset rejected", () => {
  assert.throws(() => parseCli(["claude", "demo", "pong"]), /Unknown demo preset: pong/);
});

test("parseCli: claude demo flags parsed", () => {
  const parsed = parseCli([
    "claude", "demo", "--right-model", "glm-5p2", "--no-open",
    "--out", "./x", "--yes", "--json",
  ]);
  assert.equal(parsed.ctx.rightModel, "glm-5p2");
  assert.equal(parsed.ctx.challenger, "glm-5p2");
  assert.equal(parsed.ctx.noOpen, true);
  assert.equal(parsed.ctx.out, "./x");
  assert.equal(parsed.ctx.yes, true);
  assert.equal(parsed.ctx.json, true);
});

test("parseCli: claude demo --left-model and --right-model", () => {
  const parsed = parseCli(["claude", "demo", "--left-model", "firerouter", "--right-model", "kimi-k3-fast"]);
  assert.equal(parsed.ctx.leftModel, "firerouter");
  assert.equal(parsed.ctx.rightModel, "kimi-k3-fast");
});

test("parseCli: claude demo --anthropic-model sets ctx.leftModel (legacy alias)", () => {
  assert.equal(parseCli(["claude", "demo", "--anthropic-model", "opus"]).ctx.leftModel, "opus");
  assert.equal(parseCli(["claude", "demo", "--anthropic-model", "opus"]).ctx.anthropicModel, "opus");
});

test("parseCli: claude demo --challenger sets ctx.rightModel (legacy alias)", () => {
  const parsed = parseCli(["claude", "demo", "--challenger", "glm-5p2"]);
  assert.equal(parsed.ctx.challenger, "glm-5p2");
  assert.equal(parsed.ctx.rightModel, "glm-5p2");
});

test("parseCli: claude demo rejects removed --mode", () => {
  assert.throws(
    () => parseCli(["claude", "demo", "--mode", "harness-swap"]),
    /Unknown argument: --mode.*Run: nexus help/,
  );
});

test("parseCli: --seed is no longer accepted", () => {
  assert.throws(() => parseCli(["claude", "demo", "--seed", "7"]), /Unknown argument: --seed/);
});

test("parseCli: claude demo --prompt-file", () => {
  const parsed = parseCli(["claude", "demo", "--prompt-file", "/tmp/p.txt"]);
  assert.equal(parsed.ctx.promptFile, "/tmp/p.txt");
});

test("parseCli: claude demo clean sets ctx.clean and takes --out/--yes", () => {
  const bare = parseCli(["claude", "demo", "clean"]);
  assert.equal(bare.kind, "demo");
  assert.equal(bare.ctx.clean, true);
  const withFlags = parseCli(["claude", "demo", "clean", "--out", "./x", "--yes"]);
  assert.equal(withFlags.ctx.clean, true);
  assert.equal(withFlags.ctx.out, "./x");
  assert.equal(withFlags.ctx.yes, true);
});

test("parseCli: a normal claude demo run has clean=false", () => {
  assert.equal(parseCli(["claude", "demo", "snake"]).ctx.clean, false);
});

test("parseCli: claude demo clean rejects a trailing preset", () => {
  assert.throws(() => parseCli(["claude", "demo", "clean", "snake"]), /clean takes no preset/);
});

test("parseCli: global flags may precede claude demo", () => {
  const a = parseCli(["--json", "claude", "demo", "snake"]);
  assert.equal(a.kind, "demo");
  assert.equal(a.ctx.json, true);
  assert.equal(a.ctx.prompt, "snake");
  const b = parseCli(["--home", "/tmp/x", "claude", "demo"]);
  assert.equal(b.kind, "demo");
  assert.equal(b.ctx.home, "/tmp/x");
  assert.equal(parseCli(["--json", "claude", "demo", "clean"]).ctx.clean, true);
});

test("parseCli: global flags may appear between claude and demo", () => {
  const parsed = parseCli(["claude", "--settings-path", "/s", "demo", "snake"]);
  assert.equal(parsed.kind, "demo");
  assert.equal(parsed.ctx.settingsPath, "/s");
  assert.equal(parsed.ctx.prompt, "snake");
});

test("parseCli: claude demo accepts shared global flags (e.g. --settings-path)", () => {
  const parsed = parseCli(["claude", "demo", "--settings-path", "/s"]);
  assert.equal(parsed.ctx.settingsPath, "/s");
});
