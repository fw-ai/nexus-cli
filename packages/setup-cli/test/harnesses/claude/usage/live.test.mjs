import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Writable } from "node:stream";

import {
  liveMeterKeyHint,
  runClaudeUsageLive,
  shouldRunClaudeUsageLive,
  summarizePeerAgents,
} from "../../../../lib/harnesses/claude/usage/live.mjs";
import { ANSI, DATA, METER } from "../../../../lib/ui/palette.mjs";
import { runFireconnect } from "../../../helpers.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function jsonl(entries) {
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-live-"));
  temps.push(home);
  return home;
}

function collectStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  stream.isTTY = false;
  stream.columns = 100;
  stream.rows = 40;
  return {
    stream,
    get text() {
      return text;
    },
  };
}

describe("summarizePeerAgents", () => {
  it("propagates an unpriced peer cost instead of coercing it to zero", () => {
    const summary = summarizePeerAgents([
      {
        kind: "subagent",
        label: "Priced",
        report: { requests: 2, totals: { cost: 0.25 } },
      },
      {
        kind: "subagent",
        label: "Unpriced",
        report: { requests: 1, totals: { cost: null } },
      },
      {
        kind: "main",
        label: "Main",
        report: { requests: 3, totals: { cost: null } },
      },
    ]);

    assert.equal(summary.count, 2);
    assert.equal(summary.calls, 3);
    assert.equal(summary.cost, null);
    assert.equal(summary.main.cost, null);
  });
});

describe("shouldRunClaudeUsageLive", () => {
  it("watches on a TTY", () => {
    assert.equal(shouldRunClaudeUsageLive({}, { isTTY: true }), true);
  });

  it("prints a snapshot when stdout is not a TTY", () => {
    assert.equal(shouldRunClaudeUsageLive({}, { isTTY: false }), false);
  });

  it("prints a snapshot for --json, --last-n, and --verbose", () => {
    assert.equal(shouldRunClaudeUsageLive({ json: true }, { isTTY: true }), false);
    assert.equal(shouldRunClaudeUsageLive({ lastN: "2" }, { isTTY: true }), false);
    assert.equal(shouldRunClaudeUsageLive({ verbose: true }, { isTTY: true }), false);
  });

  it("prints a snapshot for --plain even on a TTY", () => {
    // --plain asks for scrapeable output, so it must not open the interactive
    // session picker before the meter's own plain handling kicks in.
    assert.equal(shouldRunClaudeUsageLive({ plain: true }, { isTTY: true }), false);
  });
});

describe("liveMeterKeyHint", () => {
  it("advertises the session-list key when a picker exists", () => {
    assert.equal(
      liveMeterKeyHint({ canPickSession: true }),
      "Tab agents · Esc sessions · q quit",
    );
  });

  it("omits the session-list key when the meter is locked to one session", () => {
    assert.equal(
      liveMeterKeyHint({ canPickSession: false }),
      "Tab agents · q quit",
    );
  });
});

describe("meter palette uses the color guide primary accent", () => {
  it("exposes the shared METER accent/gold/ghost codes", () => {
    assert.equal(METER.accent, ANSI.primary);
    assert.equal(METER.gold, DATA.cost);
    assert.equal(METER.ghost, "\u001b[38;5;245m");
    assert.equal(METER.modelPalette.length, 9);
    assert.equal(METER.modelPalette[0], "38;2;49;212;211", "badges use the Design System V2 data colors");
  });
});

describe("runClaudeUsageLive meter UI", () => {
  it("renders per-turn meter rows as the session grows", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sessionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const logPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeFile(logPath, jsonl([
      { type: "user", message: { content: "first turn" } },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      },
    ]));

    const out = collectStream();
    const controller = new AbortController();
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 1) {
        await appendFile(logPath, jsonl([
          { type: "user", message: { content: "second turn" } },
          {
            type: "assistant",
            message: {
              id: "msg_2",
              model: "accounts/fireworks/models/kimi-k3",
              usage: { input_tokens: 500_000, output_tokens: 100_000 },
            },
          },
        ]));
      }
      if (polls >= 4) controller.abort();
    };

    await runClaudeUsageLive({
      home,
      session: sessionId,
      plain: true,
      stream: out.stream,
      signal: controller.signal,
      sleep,
      pollMs: 0,
    });

    assert.match(out.text, /Live Cost Meter|✦/);
    assert.match(out.text, /TOTAL/);
    assert.match(out.text, /first turn/);
    assert.match(out.text, /GLM/);
    assert.match(out.text, /Kimi/);
    assert.match(out.text, /\$4\.4000|\$1\.4000/);
  });

  it("fails fast on an unknown session id", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl"),
      "\n",
    );
    await assert.rejects(
      () => runClaudeUsageLive({
        home,
        session: "does-not-exist",
        plain: true,
        stream: collectStream().stream,
        signal: AbortSignal.abort(),
        sleep: async () => {},
      }),
      /No Claude Code session log matching/,
    );
  });
});

describe("fireconnect claude usage help", () => {
  it("documents live watch without --live/--once flags", async () => {
    const result = await runFireconnect(["claude", "help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /live cost meter|Live per-turn cost meter|Pick session|live Main|Main meter|← agents|subagent/i);
    assert.doesNotMatch(result.stdout, /tmux/i, "the retired `claude live` split is not advertised");
    assert.doesNotMatch(result.stdout, /--live/);
    assert.doesNotMatch(result.stdout, /--once/);
  });
});
