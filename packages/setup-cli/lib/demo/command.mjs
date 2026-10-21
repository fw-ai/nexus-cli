/**
 * `nexus demo` — races two models on the same prompt via Claude Code,
 * streams both live in a split-pane terminal UI, then opens a browser comparison.
 */

import process from "node:process";
import path from "node:path";
import { cp, mkdir, mkdtemp, rm, readdir, stat } from "node:fs/promises";
import os from "node:os";

import { HARNESS } from "../harness/id.mjs";
import { getHeadlessRunner, SUPPORTED_HARNESS_IDS } from "./harness-runners.mjs";
import { extractHtml, looksRunnable } from "./html-extract.mjs";
import { buildResult, formatSpeedRatio, formatUsd, formatSeconds } from "./measurement.mjs";
import {
  prepareOutputDir, writeStreamLog, writeAppHtml, writeResultJson, writeCompareHtml,
  readBestHtmlFromDir,
} from "./output.mjs";
import { SplitPaneRenderer, isTtyCapable } from "./tui.mjs";
import { confirmYesNo, pressAnyKeyToExit } from "./key-prompt.mjs";
import { buildCompareHtml, serveStatic, openInBrowser } from "./browser.mjs";
import { GREEN, CYAN, YELLOW, BOLD, RESET } from "./ansi.mjs";
import {
  demoModelLabel,
  demoSideDisplayLabel,
} from "./demo-models.mjs";
import { normalizeOptions, prepareDemoRun } from "./demo-prep.mjs";
import { DEMO_CANCELLED_MSG } from "./demo-readiness.mjs";
import { demoSystemPrompt } from "./presets.mjs";

const DEFAULT_OUT_DIR = "./nexus-demo";

// Files the demo writes at the root of its output dir. `demo clean` treats a
// directory as demo output ONLY if it holds one of these, so it can never delete
// an unrelated folder a user happened to point --out at.
const DEMO_OUTPUT_MARKERS = ["result.json", "compare.html", "rates.json", "prompt.txt"];
// Prefixes of the throwaway tmp dirs the demo creates during a run (per-side
// cwds + the route-settings dir). Normal and Ctrl-C exits remove these; a hard
// crash can leave them behind, so `demo clean` sweeps any stragglers.
const DEMO_TMP_PREFIXES = ["fc-demo-inc-", "fc-demo-fw-", "fireconnect-demo-"];

// ── `nexus demo clean` ──────────────────────────────────────────────────

/** @param {string} p @returns {Promise<boolean>} */
async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only if `dir` holds a recognizable demo output marker. This is the guard
 * that keeps `demo clean` from ever removing a directory the demo didn't create.
 * @param {string} dir @returns {Promise<boolean>}
 */
export async function isDemoOutputDir(dir) {
  try {
    const entries = new Set(await readdir(dir));
    return DEMO_OUTPUT_MARKERS.some((m) => entries.has(m));
  } catch {
    return false; // missing / not a directory
  }
}

/**
 * Leftover per-run tmp dirs (from a crashed run). `tmpRoot` is injectable so the
 * sweep can be tested without touching the real system tmp.
 * @param {string} [tmpRoot] @returns {Promise<string[]>}
 */
export async function findStaleDemoTmp(tmpRoot = os.tmpdir()) {
  let names;
  try {
    names = await readdir(tmpRoot);
  } catch {
    return [];
  }
  return names
    .filter((n) => DEMO_TMP_PREFIXES.some((p) => n.startsWith(p)))
    .map((n) => path.join(tmpRoot, n));
}

/**
 * Remove the demo's generated output dir (guarded by the marker check) and sweep
 * any crashed-run tmp dirs. Confirms before deleting output unless --yes, since
 * the on-disk compare.html is the shareable artifact of a run.
 *
 * @param {any} ctx  parsed context (ctx.out, ctx.yes)
 * @param {{ tmpRoot?: string }} [opts]  injectable tmp root for tests
 */
export async function runDemoClean(ctx, { tmpRoot = os.tmpdir() } = {}) {
  const outDir = path.resolve(ctx.out || DEFAULT_OUT_DIR);
  const removed = [];

  if (await isDemoOutputDir(outDir)) {
    const canPrompt = isTtyCapable() && !ctx.yes;
    const ok = canPrompt
      ? await confirmYesNo(`Remove demo output at ${outDir}?`, { stdin: process.stdin, stdout: process.stdout })
      : true;
    if (ok) {
      await rm(outDir, { recursive: true, force: true });
      removed.push(outDir);
    } else {
      console.log("  Left the demo output in place.");
    }
  } else if (await pathExists(outDir)) {
    console.log(`  ${DIM(`${outDir} doesn't look like demo output (no result.json/compare.html) — leaving it untouched.`)}`);
  }

  // Sweep crashed-run tmp dirs. Harmless garbage; run when no demo is in flight.
  for (const dir of await findStaleDemoTmp(tmpRoot)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    removed.push(dir);
  }

  if (removed.length === 0) {
    console.log("  Nothing to clean.");
  } else {
    console.log(`  Cleaned ${removed.length} item${removed.length === 1 ? "" : "s"}:`);
    for (const r of removed) {
      console.log(`    ${DIM(r)}`);
    }
  }
}

/**
 * @param {any} ctx  parsed HarnessContext (kind === "demo")
 */
export async function runDemoCommand(ctx) {
  if (ctx.clean) {
    return runDemoClean(ctx);
  }
  const options = normalizeOptions(ctx);

  const useTui = isTtyCapable() && !options.json;
  const openBrowser = useTui && !options.noOpen;
  const emitJson = options.json || !isTtyCapable();

  const abort = new AbortController();
  let renderer = null;
  let tearingDown = false;
  // Cleanup for tmp route-settings + per-side working dirs (harness-swap only).
  // Fire-and-forget on SIGINT (the OS reaps /tmp); the normal path awaits it.
  const cleanupFns = [];
  const runCleanup = () => Promise.all(cleanupFns.map((fn) => fn().catch(() => {})));
  const teardown = (code) => {
    if (tearingDown) {
      return;
    }
    tearingDown = true;
    abort.abort();
    try { renderer?.stop(); } catch { /* noop */ }
    // Restore the TTY before exiting: a SIGINT from an external `kill -INT`
    // (or a Ctrl-C that slips through a non-raw window) can arrive while a
    // prompt/form left stdin in raw mode or the cursor hidden. The prompts
    // clean up on their own Ctrl-C byte, but this is the defensive backstop so
    // the terminal is never left unusable on exit.
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
    } catch { /* noop */ }
    process.stdout.write("\x1b[?25h"); // SHOW_CURSOR
    runCleanup();
    if (code != null) {
      process.exit(code);
    }
  };
  process.on("SIGINT", () => {
    process.stderr.write("\nInterrupted — cleaning up.\n");
    teardown(130);
  });

  const {
    options: runOptions,
    prompt,
    leftLabel,
    rightLabel,
    leftRates,
    rightRates,
  } = await prepareDemoRun({ ctx, options, useTui }).catch((err) => {
    if (err instanceof Error && err.message === DEMO_CANCELLED_MSG) {
      teardown(1);
      return null;
    }
    throw err;
  });
  if (!runOptions) {
    return;
  }

  if (useTui && runOptions.yes) {
    printFraming(leftLabel, rightLabel);
  }

  // ── prepare output dir ────────────────────────────────────────────────────
  const outDir = path.resolve(runOptions.out);
  const mode = "harness-swap";
  const dirs = await prepareOutputDir(outDir, {
    prompt: { title: prompt.title, text: prompt.prompt, source: prompt.source, presetId: prompt.presetId },
    mode,
    challengerModel: runOptions.rightModel,
  });

  /** @type {any} */
  const incRunProto = makeSideProto("incumbent", runOptions.leftModel, leftRates);
  /** @type {any} */
  const fwRunProto = makeSideProto("fireworks", runOptions.rightModel, rightRates);

  let incumbentAppHtml = "";
  let fireworksAppHtml = "";

  let leftRunner;
  let rightRunner;
  let incCwd = null;
  let fwCwd = null;
  const runner = getHeadlessRunner(HARNESS.CLAUDE);
  if (!runner) {
    throw new Error(
      `Demo doesn't have a headless runner for Claude Code yet. `
      + `Supported: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
    );
  }
  const {
    leftCliModel,
    rightCliModel,
    cleanup: cleanupRoute,
  } = await runner.buildRaceSettings({
    leftModel: runOptions.leftModel,
    rightModel: runOptions.rightModel,
    home: ctx.home,
    settingsPath: ctx.settingsPath,
  });
  cleanupFns.push(cleanupRoute);
  // Each side runs in an isolated tmp dir, NOT inside the repo. This is load
  // bearing: Claude Code derives context from its cwd, so a work dir inside a
  // project pulls in that project's skills, MCP instructions, agent listings and
  // git branch — none of which belong in a model-vs-model benchmark, and all of
  // which inflate input tokens and make runs non-comparable. mkdtemp also keeps
  // concurrent demos from colliding.
  //
  // Whatever the model writes is copied to <out>/work/<side> after the run (see
  // collectWorkDir) so the artifacts are still there to inspect.
  incCwd = await mkdtemp(path.join(os.tmpdir(), "fc-demo-inc-"));
  fwCwd = await mkdtemp(path.join(os.tmpdir(), "fc-demo-fw-"));
  cleanupFns.push(async () => rm(incCwd, { recursive: true, force: true }).catch(() => {}));
  cleanupFns.push(async () => rm(fwCwd, { recursive: true, force: true }).catch(() => {}));
  // ONE marker for the whole race: both sides must get the identical system
  // prompt (a fair comparison), while each race differs from the last (so
  // neither side can inherit a warm prompt cache and look artificially cheap).
  const runSystemPrompt = demoSystemPrompt();
  leftRunner = (io) => runner.runSide({
    cwd: incCwd, prompt: prompt.prompt, model: leftCliModel, systemPrompt: runSystemPrompt, ...io,
  });
  rightRunner = (io) => runner.runSide({
    cwd: fwCwd, prompt: prompt.prompt, model: rightCliModel, systemPrompt: runSystemPrompt, ...io,
  });

  let incResult = null;
  let fwResult = null;
  if (useTui) {
    renderer = new SplitPaneRenderer({
      incumbent: sideHeader(incRunProto, leftRates, "measured"),
      fireworks: sideHeader(fwRunProto, rightRates, "measured"),
      mode: "race",
    });
    renderer.start();
    const onErr = (side) => (r) => renderer.finish(side, {
      ok: false,
      error: r.error,
      inputTokens: r.inputTokens ?? 0,
      cacheWrite1hTokens: r.cacheWrite1hTokens ?? 0,
      cacheWrite5mTokens: r.cacheWrite5mTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      seconds: r.seconds ?? 0,
      cost: r.usagePricing?.cost ?? null,
    });
    // Freeze each side's clock the instant ITS OWN runner resolves — not after
    // both finish — so the faster side stops ticking at its real finish time and
    // the header flips to "X finished · Y still running". finalizeBoth (which
    // reconciles tokens/cost) runs only once both are done, so the reconciled
    // numbers land via finish() afterward while the frozen clock is preserved.
    const raceSide = (runner, side) => runner({
      signal: abort.signal,
      onDelta: (t) => renderer.pushDelta(side, t),
      onThinking: (t) => renderer.pushThinking(side, t),
      onTokens: (tok) => renderer.setTokens(side, tok),
      onError: onErr(side),
      onStatus: (t) => renderer.setStatus(side, t),
      onResetOutput: () => renderer.resetOutput(side),
    }).then((r) => { renderer.freeze(side, r.ok); return r; });
    // try/finally so a thrown error (a runner rejects, finalizeBoth throws) can't
    // leave the 10Hz render interval running and pin the event loop on exit.
    try {
      [incResult, fwResult] = await Promise.all([
        raceSide(leftRunner, "incumbent"),
        raceSide(rightRunner, "fireworks"),
      ]);
      await finalizeBoth({
        incResult, fwResult,
        setIncHtml: (h) => { incumbentAppHtml = h; }, setFwHtml: (h) => { fireworksAppHtml = h; },
        incRunProto, fwRunProto, incCwd, fwCwd,
      });
      renderer.finish("incumbent", sideFinal(incRunProto));
      renderer.finish("fireworks", sideFinal(fwRunProto));
    } finally {
      renderer.stop();
    }
  } else {
    // Non-TTY / --json: run both without the live renderer.
    [incResult, fwResult] = await Promise.all([
      leftRunner({ signal: abort.signal }),
      rightRunner({ signal: abort.signal }),
    ]);
    await finalizeBoth({ incResult, fwResult,
      setIncHtml: (h) => { incumbentAppHtml = h; }, setFwHtml: (h) => { fireworksAppHtml = h; },
      incRunProto, fwRunProto, incCwd, fwCwd });
  }

  // Preserve each side's scratch dir BEFORE runCleanup() removes the tmp dirs,
  // so whatever the model wrote stays inspectable under <out>/work/<side>.
  await collectWorkDir(incCwd, outDir, "incumbent");
  await collectWorkDir(fwCwd, outDir, "fireworks");

  await runCleanup();

  // FC_DEBUG: print the full (unsliced) error body of any side that failed at
  // the request layer, so the provider's actual `message` field is visible.
  // The TUI truncates to 200 chars, which usually cuts off the cause. Emitted
  // after the renderer has stopped so it doesn't corrupt the live display.
  if (process.env.FC_DEBUG) {
    if (incResult?.errorBody) process.stderr.write(`\n[FC_DEBUG] incumbent error body:\n${incResult.errorBody}\n\n`);
    if (fwResult?.errorBody) process.stderr.write(`\n[FC_DEBUG] fireworks error body:\n${fwResult.errorBody}\n\n`);
  }

  // ── write outputs (audit) ─────────────────────────────────────────────────
  const result = buildResult({
    incumbent: incRunProto,
    fireworks: fwRunProto,
    prompt: { title: prompt.title, text: prompt.prompt, source: prompt.source, presetId: prompt.presetId },
    mode,
  });
  result.createdAt = new Date().toISOString();
  await writeResultJson(outDir, result, {
    incumbent: result.incumbent.rates,
    fireworks: result.fireworks.rates,
  });
  await writeAppHtml(dirs.incumbentDir, incumbentAppHtml);
  await writeAppHtml(dirs.fireworksDir, fireworksAppHtml);
  // Token logs come straight off each side's result object — no module-level
  // stash, so a second run in the same process can't cross-contaminate logs.
  await writeStreamLog(dirs.incumbentDir, incResult?.tokenLog ?? []);
  await writeStreamLog(dirs.fireworksDir, fwResult?.tokenLog ?? []);

  // ── State 4: verdict ──────────────────────────────────────────────────────
  if (useTui) {
    printVerdict(result, leftLabel, rightLabel);
  }

  // ── State 5: browser handoff ──────────────────────────────────────────────
  // Build the on-disk comparison page for any TTY run (it's referenced by both
  // the browser-open and --no-open paths, so the printed path always exists).
  let server = null;
  if (useTui) {
    const compareHtml = buildCompareHtml({
      result,
      incumbentAppHtml,
      fireworksAppHtml,
      incumbentRunnable: incRunProto.appRunnable,
      fireworksRunnable: fwRunProto.appRunnable,
      incumbentLabel: leftLabel,
      fireworksLabel: rightLabel,
      copySummary: buildCopySummary(result, leftLabel, rightLabel),
    });
    await writeCompareHtml(outDir, compareHtml);
  }
  if (openBrowser) {
    let handoffUrl = "";
    try {
      server = await serveStatic(outDir);
      handoffUrl = server.url;
    } catch {
      handoffUrl = "";
    }
    if (handoffUrl) {
      const opened = openInBrowser(handoffUrl);
      if (opened) {
        console.log(`\n  ${GREEN}✓${RESET} ${BOLD}Opening comparison in your browser…${RESET}`);
        console.log(`    ${CYAN}${handoffUrl}${RESET}`);
      } else {
        console.log(`\n  ${YELLOW}⚠${RESET} Couldn't open a browser. View it at:`);
        console.log(`    ${CYAN}${handoffUrl}${RESET}`);
      }
    } else {
      const fileUrl = `file://${path.join(outDir, "compare.html")}`;
      // Branch on the actual result, like the HTTP path does — a failed open
      // must not print a green success line.
      const openedFile = openInBrowser(fileUrl);
      if (openedFile) {
        console.log(`\n  ${GREEN}✓${RESET} ${BOLD}Opening comparison in your browser…${RESET}`);
      } else {
        console.log(`\n  ${YELLOW}⚠${RESET} Couldn't open a browser. View it at:`);
      }
      console.log(`    ${CYAN}${fileUrl}${RESET}`);
    }
    console.log(`  ${DIM(`On-disk copy: ${path.join(outDir, "compare.html")}`)}`);
  } else if (useTui) {
    // TTY but --no-open: skip the browser, just point at the on-disk page.
    console.log(`\n  ${BOLD}Comparison page${RESET}`);
    console.log(`    ${CYAN}${path.join(outDir, "compare.html")}${RESET}`);
  }

  // ── json output ───────────────────────────────────────────────────────────
  if (emitJson) {
    console.log(JSON.stringify(result, null, 2));
  }

  // The static server has to outlive `open <url>` long enough for the browser to
  // fetch compare.html — but the old fixed 60s timer pinned the event loop open,
  // so the CLI appeared to hang for a full minute after printing every result.
  // Hold under the user's control instead: wait for a keypress, then close and
  // return so the process exits at once. The timeout is the unattended-run
  // backstop — it resolves the wait (not just the server) so the process always
  // exits, at worst 5 minutes later.
  if (server) {
    await pressAnyKeyToExit({
      stdin: process.stdin,
      stdout: process.stdout,
      timeoutMs: 5 * 60_000,
      minHoldMs: 2_000,
      message: DIM(`Press any key to exit — if the local URL expires, open ${path.join(outDir, "compare.html")}`),
    });
    try { server.close(); } catch { /* noop */ }
  }
}

/**
 * Copy whatever a side wrote in its isolated tmp cwd into <out>/work/<side> so
 * the artifacts survive the run for inspection. Best-effort: a failure here must
 * never fail the demo, since the comparison itself is already complete.
 * @param {string} cwd  the side's tmp working dir
 * @param {string} outDir
 * @param {string} side "incumbent" | "fireworks"
 */
async function collectWorkDir(cwd, outDir, side) {
  if (!cwd) {
    return;
  }
  try {
    // A model that returns the file as text (rather than calling Write) leaves
    // an empty scratch dir — don't litter the output with empty work/ folders.
    const entries = await readdir(cwd);
    if (entries.length === 0) {
      return;
    }
    const dest = path.join(outDir, "work", side);
    // Clear any previous run's artifacts first: cp overwrites but never deletes,
    // so leftovers would mix into this run's work dir and read as its output.
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(cwd, dest, { recursive: true, force: true });
  } catch { /* artifacts are a nicety; never break the run over them */ }
}

function makeSideProto(side, modelId, rates) {
  const label = demoModelLabel(modelId);
  const [provider] = demoSideDisplayLabel(modelId).split(" · ");
  return {
    side,
    provider,
    model: label,
    modelId,
    callMode: "live",
    inputTokens: 0,
    cacheWrite1hTokens: 0,
    cacheWrite5mTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    seconds: 0,
    cost: 0,
    rates: rateShape(rates, provider),
    debug: {},
    ok: false,
    appRunnable: false,
  };
}

async function finalizeBoth({ incResult, fwResult, setIncHtml, setFwHtml, incRunProto, fwRunProto, incCwd, fwCwd }) {
  await finalizeSide(fwRunProto, fwResult, setFwHtml, { cwd: fwCwd });
  await finalizeSide(incRunProto, incResult, setIncHtml, { cwd: incCwd });
}

async function finalizeSide(proto, result, setHtml, { cwd = null } = {}) {
  if (!result?.ok) {
    proto.ok = false;
    proto.error = result?.error || "generation failed";
    proto.seconds = result?.seconds ?? 0;
    // A failed race is exactly when the transcript pointer matters most, so the
    // debug block is written on this path too, not only on success.
    proto.debug = {
      sessionId: result?.sessionId || "",
      resolvedModel: result?.resolvedModel || "",
      pricedModel: result?.usagePricing?.model || "",
      cwd: cwd || "",
    };
    proto.inputTokens = result?.inputTokens ?? 0;
    proto.outputTokens = result?.outputTokens ?? 0;
    proto.cost = result?.usagePricing?.cost ?? null;
    proto.appRunnable = false;
    setHtml(result?.text ? extractHtml(result.text).html : "");
    return;
  }

  let { html } = extractHtml(result.text);
  let runnable = looksRunnable(html);
  // Harness-swap agentic runs may write the app to a file and return a prose
  // summary instead of inlining the HTML. Fall back to the best .html file the
  // tool wrote in its working dir so the app still renders.
  if (!runnable && cwd) {
    const fromDisk = await readBestHtmlFromDir(cwd);
    if (fromDisk && looksRunnable(fromDisk)) {
      html = fromDisk;
      runnable = true;
    }
  }
  proto.ok = true;
  proto.inputTokens = result.inputTokens ?? 0;
  proto.cacheWrite1hTokens = result.cacheWrite1hTokens ?? 0;
  proto.cacheWrite5mTokens = result.cacheWrite5mTokens ?? 0;
  proto.cacheReadTokens = result.cacheReadTokens ?? 0;
  proto.outputTokens = result.outputTokens ?? 0;
  proto.seconds = result.seconds;
  // The runner already prices the authoritative result usage (or its final
  // per-message aggregate) through the same canonical engine as statusline.
  // Claude Code's own `costUsd` is diagnostic only: it applies Anthropic rates
  // to Fireworks models whose cost basis it does not know.
  proto.cost = result.usagePricing?.cost ?? null;
  if (result.usagePricing?.rates) {
    proto.rates = rateShape(result.usagePricing.rates, proto.provider);
  }
  proto.appRunnable = runnable;
  // Session id + cwd locate this run's Claude Code transcript at
  // ~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl; resolvedModel records
  // what actually served the request vs what was requested.
  proto.debug = {
    sessionId: result.sessionId || "",
    resolvedModel: result.resolvedModel || "",
    pricedModel: result.usagePricing?.model || "",
    cwd: cwd || "",
  };
  setHtml(html);
}

function sideFinal(proto) {
  return {
    ok: proto.ok,
    inputTokens: proto.inputTokens,
    cacheWrite1hTokens: proto.cacheWrite1hTokens,
    cacheWrite5mTokens: proto.cacheWrite5mTokens,
    cacheReadTokens: proto.cacheReadTokens,
    outputTokens: proto.outputTokens,
    seconds: proto.seconds,
    cost: proto.cost,
    error: proto.error,
  };
}

// ── pricing helpers ─────────────────────────────────────────────────────────

function rateShape(rates, providerLabel) {
  return {
    inputPerMillion: rates.inputPerMillion,
    outputPerMillion: rates.outputPerMillion,
    cachedInputPerMillion: rates.cachedInputPerMillion ?? 0,
    cacheWrite1hPerMillion: rates.cacheWrite1hPerMillion ?? 0,
    cacheWrite5mPerMillion: rates.cacheWrite5mPerMillion ?? 0,
    cacheReadPerMillion: rates.cacheReadPerMillion ?? rates.cachedInputPerMillion ?? 0,
    tier: rates.tier,
    source: rates.source,
    label: rates.label ?? providerLabel,
    estimated: rates.estimated ?? false,
  };
}

function sideHeader(proto, rates, costLabel) {
  return {
    provider: proto.provider,
    model: proto.model,
    costLabel,
    rates: {
      inputPerMillion: rates.inputPerMillion,
      outputPerMillion: rates.outputPerMillion,
      cacheWrite1hPerMillion: rates.cacheWrite1hPerMillion ?? 0,
      cacheWrite5mPerMillion: rates.cacheWrite5mPerMillion ?? 0,
      cacheReadPerMillion: rates.cacheReadPerMillion ?? 0,
    },
  };
}

// ── UI: states 1, 2, 4, 6 ───────────────────────────────────────────────────

function printFraming(leftLabel, rightLabel) {
  console.log("");
  console.log("  Nexus Demo");
  console.log("  Same prompt, two models. Let's build something and race.");
  console.log("");
  console.log(`  Left:   ${leftLabel}`);
  console.log(`  Right:  ${rightLabel}`);
  console.log("");
}

/** Shorten a side label for the verdict line: drop the " (Latest)" suffix so
 *  "GLM 5.2 Fast (Latest)" reads "GLM 5.2 Fast". */
function shortLabel(label) {
  return String(label).replace(/\s*\(Latest\)\s*$/, "").trim();
}

function printVerdict(result, leftLabel, rightLabel) {
  const left = shortLabel(leftLabel);
  const right = shortLabel(rightLabel);
  const speedPart = verdictSpeed(result, left, right);
  const costPart = verdictCost(result, left, right);
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  const bothRunnable = bothOk && result.incumbent.appRunnable && result.fireworks.appRunnable;
  console.log("");
  console.log(`  ${CYAN}${"─".repeat(58)}${RESET}`);
  // The headline verdict — bold, with the winning side's name in green.
  console.log(`  ${BOLD}${speedPart} · ${costPart}${RESET}`);
  if (bothRunnable) {
    console.log(`  ${GREEN}✓${RESET} Both built a working app. ${DIM("See for yourself →")}`);
  } else if (!bothOk) {
    const failed = !result.incumbent.ok ? left : right;
    console.log(`  ${YELLOW}⚠${RESET} The run was incomplete (${failed} failed). No winner declared on a partial result.`);
  } else {
    console.log(`  ${YELLOW}⚠${RESET} One build didn't run. ${DIM("See for yourself →")}`);
  }
  console.log(`  ${DIM("Costs are what Claude Code reported for each run, not estimates.")}`);
  console.log(`  ${CYAN}${"─".repeat(58)}${RESET}`);
}

function verdictSpeed(result, leftLabel, rightLabel) {
  const ratio = result.summary.speedRatio;
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (!bothOk || !ratio || !Number.isFinite(ratio) || ratio <= 0) {
    return "speed not comparable";
  }
  const incSec = result.incumbent.seconds;
  const fwSec = result.fireworks.seconds;
  if (ratio > 1) {
    return `${rightLabel} ${formatSpeedRatio(ratio)} faster (${formatSeconds(fwSec)} vs ${formatSeconds(incSec)})`;
  }
  if (ratio < 1) {
    return `${leftLabel} ${formatSpeedRatio(1 / ratio)} faster (${formatSeconds(incSec)} vs ${formatSeconds(fwSec)})`;
  }
  return `a dead heat on speed (${formatSeconds(incSec)} each)`;
}

function verdictCost(result, leftLabel, rightLabel) {
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (!bothOk) {
    return "cost not comparable";
  }
  const cf = result.summary.costSavedFraction;
  if (!Number.isFinite(cf)) {
    return "cost not comparable";
  }
  const incCost = result.incumbent.cost;
  const fwCost = result.fireworks.cost;
  // Rebase to the more-expensive model's cost when the incumbent is cheaper so
  // the percentage matches the compare.html strip (same race, one number) —
  // costSavedFraction is incumbent-relative, so |(inc-fw)/inc| would inflate
  // the savings (2× cost → 100% instead of 50%).
  let frac = cf;
  let cheaperLabel = rightLabel;
  let cheaperCost = fwCost;
  let pricierCost = incCost;
  if (cf < 0) {
    frac = fwCost > 0 ? (fwCost - incCost) / fwCost : Number.NaN;
    cheaperLabel = leftLabel;
    cheaperCost = incCost;
    pricierCost = fwCost;
  }
  const pct = Math.round(frac * 100);
  const costs = `${formatUsd(cheaperCost)} vs ${formatUsd(pricierCost)}`;
  if (pct > 0) {
    return `${cheaperLabel} ${pct}% cheaper (${costs})`;
  }
  if (pct < 0) {
    return `${cheaperLabel} ${Math.abs(pct)}% more expensive (${costs})`;
  }
  return `same cost (${costs})`;
}

function buildCopySummary(result, leftLabel, rightLabel) {
  const left = shortLabel(leftLabel);
  const right = shortLabel(rightLabel);
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (!bothOk) {
    return `Raced ${left} vs ${right} on the ${result.promptTitle} prompt — one side didn't finish, so no comparison. Built with \`nexus claude demo\`.`;
  }
  const speedPart = verdictSpeedText(result, left, right);
  const cf = result.summary.costSavedFraction;
  if (!Number.isFinite(cf)) {
    const bothRunnable = result.incumbent.appRunnable && result.fireworks.appRunnable;
    const appPart = bothRunnable ? ", working app" : ", one build didn't run";
    return (
      `Raced ${left} vs ${right} on the same ${result.promptTitle} prompt. `
      + `${speedPart}, cost not comparable${appPart}. Built with \`nexus claude demo\`.`
    );
  }
  // Rebase to match the compare.html strip and terminal verdict (same race,
  // one percentage) — incumbent-relative |costSavedFraction| inflates savings.
  let frac = cf;
  let cheaperLabel = right;
  let cheaperCost = result.fireworks.cost;
  let pricierCost = result.incumbent.cost;
  if (Number.isFinite(cf) && cf < 0) {
    frac = result.fireworks.cost > 0
      ? (result.fireworks.cost - result.incumbent.cost) / result.fireworks.cost
      : Number.NaN;
    cheaperLabel = left;
    cheaperCost = result.incumbent.cost;
    pricierCost = result.fireworks.cost;
  }
  const pct = Math.round(frac * 100);
  const costs = `${formatUsd(cheaperCost)} vs ${formatUsd(pricierCost)}`;
  const costPart = pct > 0
    ? `${cheaperLabel} ${pct}% cheaper (${costs})`
    : pct < 0
      ? `${cheaperLabel} ${Math.abs(pct)}% more expensive (${costs})`
      : `same cost (${costs})`;
  const bothRunnable = result.incumbent.appRunnable && result.fireworks.appRunnable;
  const appPart = bothRunnable ? ", working app" : ", one build didn't run";
  return (
    `Raced ${left} vs ${right} on the same ${result.promptTitle} prompt. `
    + `${speedPart}, ${costPart}${appPart}. Built with \`nexus claude demo\`.`
  );
}

function verdictSpeedText(result, leftLabel, rightLabel) {
  const ratio = result.summary.speedRatio;
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) {
    return "speed not comparable";
  }
  if (ratio > 1) {
    return `${rightLabel} ${formatSpeedRatio(ratio)} faster`;
  }
  if (ratio < 1) {
    return `${leftLabel} ${formatSpeedRatio(1 / ratio)} faster`;
  }
  return "a dead heat on speed";
}

// ── terminal IO helpers ──────────────────────────────────────────────────────

// Bright-black unless COLORFGBG positively reports a dark bg (0|8). ANSI faint
// (\x1b[2m) is near-invisible on light backgrounds, and most terminals don't
// set COLORFGBG, so default to the readable bright-black gray. See
// lib/demo/ansi.mjs for the full rationale.
const _DIM_CODE = (() => {
  const fgbg = process.env.COLORFGBG ?? "";
  const parts = fgbg.split(";");
  const bg = parts.length === 2 ? Number(parts[1]) : NaN;
  return bg === 0 || bg === 8 ? "\x1b[2m" : "\x1b[90m";
})();

function DIM(s) {
  return `${_DIM_CODE}${s}\x1b[0m`;
}
