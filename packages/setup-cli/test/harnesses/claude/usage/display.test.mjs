import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  formatClaudeUsageInteractiveFrame,
  formatClaudeUsageSummaryDisplay,
  formatClaudeUsageReportsSummaryDisplay,
  hasClaudeUsageRows,
  renderSegmentedBar,
  runClaudeUsageInteractiveDisplay,
} from "../../../../lib/harnesses/claude/usage/display.mjs";
import { formatUsageCost } from "../../../../lib/harnesses/claude/usage/format.mjs";

function lastInteractiveFrame(text) {
  const plain = String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const index = plain.lastIndexOf("nexus usage");
  return index === -1 ? plain : plain.slice(index);
}

describe("claude usage display", () => {
  it("renders proportional segmented bars", () => {
    const bar = renderSegmentedBar([
      { value: 3, color: "\u001b[36m", label: "a" },
      { value: 1, color: "\u001b[32m", label: "b" },
    ], 8, { isTTY: false });
    assert.equal(bar.replace(/\u001b\[[0-9;]*m/g, "").length, 8);
    assert.match(bar, /█/);
  });

  it("never overflows a segmented bar when there are more segments than cells", () => {
    const bar = renderSegmentedBar(
      Array.from({ length: 20 }, (_, index) => ({ value: index + 1, color: "", label: String(index) })),
      7,
      { isTTY: false },
    );
    assert.equal(bar.length, 7);
  });

  it("formats a single-session summary with cost bar and model sections", () => {
    const report = {
      path: "/tmp/12345678-1234-4234-9234-123456789abc.jsonl",
      requests: 2,
      rows: [
        {
          model: "accounts/fireworks/models/glm-5p2",
          displayModel: "glm-5p2",
          input: 1_000,
          output: 3_000,
          cacheRead: 2_000,
          cost: 0.07,
        },
        {
          model: "claude-opus-4-8",
          displayModel: "claude-opus-4-8",
          input: 2,
          output: 4,
          cacheRead: 0,
          cost: 0.09,
        },
      ],
      totals: { input: 1_002, output: 3_004, cacheRead: 2_000, cost: 0.16 },
      grandTotals: { input: 1_002, output: 3_004, cacheRead: 2_000, cost: 0.16 },
      grandRequests: 2,
      subagents: [],
      estimated: false,
    };

    const text = formatClaudeUsageSummaryDisplay(report, { stream: { isTTY: false } });
    assert.match(text, /nexus usage · last 1 session/);
    assert.match(text, /TOTAL SPEND/);
    assert.match(text, /\$0\.16/);
    assert.match(text, /SESSIONS/);
    assert.match(text, /CALLS/);
    assert.match(text, /TOKENS/);
    assert.match(text, /SESSION ID\n▾ 12345678/);
    assert.match(text, /▾ 12345678/);
    assert.match(text, /MODEL\s+COST\s+SHARE\s+%/);
    assert.equal(text.split("\n").find((line) => line.startsWith("▾")), "▾ 12345678");
    assert.match(text, /glm-5p2/);
    assert.match(text, /claude-opus-4-8/);
    assert.match(text, /2K cache read/);
    assert.match(text, /Fireworks-served model estimate per request: \(input \* input rate/);
    assert.match(text, /Anthropic model usage is fetched from session logs; estimated cost is calculated from local rates/);
    assert.match(text, /\*\*\*All pricing shown below are estimates based on token usage/);
    assert.match(text, /Use -v \/ --verbose for request and sub-agent details/);
    assert.doesNotMatch(text, /Parent\/Sub-agent ID/);
  });

  it("keeps a sub-cent total at the precision the status line quotes", () => {
    // One real GLM 5.3 call: 2,086 uncached + 15,222 cached in, 3 out.
    const cost = 0.006891;
    const row = {
      model: "accounts/fireworks/models/glm-5p3",
      displayModel: "glm-5p3",
      input: 2_086,
      output: 3,
      cacheRead: 15_222,
      cost,
    };
    const totals = { input: 2_086, output: 3, cacheRead: 15_222, cost };
    const text = formatClaudeUsageSummaryDisplay({
      path: "/tmp/12345678-1234-4234-9234-123456789abc.jsonl",
      requests: 1,
      rows: [row],
      totals,
      grandTotals: totals,
      grandRequests: 1,
      subagents: [],
      estimated: false,
    }, { stream: { isTTY: false } });

    // The cent is not the floor: rounding this up to `$0.01` would overstate a
    // known figure by 45%.
    assert.match(text, /\$0\.0069/);
    assert.doesNotMatch(text, /\$0\.01(\D|$)/);
    // And the status line quotes that same figure, digit for digit.
    assert.equal(formatUsageCost(cost), "$0.0069");
  });

  it("shows fallback pricing disclaimer in static and interactive estimated summaries", () => {
    const report = {
      path: "/tmp/12345678-1234-4234-9234-123456789abc.jsonl",
      rows: [{
        model: "unknown-model",
        displayModel: "unknown-model",
        input: 1_000,
        output: 2_000,
        cacheRead: 0,
        cost: 0.01,
      }],
      totals: { input: 1_000, output: 2_000, cacheRead: 0, cost: 0.01 },
      grandTotals: { input: 1_000, output: 2_000, cacheRead: 0, cost: 0.01 },
      grandRequests: 1,
      subagents: [],
      estimated: true,
    };
    const warning = /Some rows used fallback pricing for unrecognized model ids\./;

    const staticText = formatClaudeUsageSummaryDisplay(report, { stream: { isTTY: false, columns: 140 } });
    const interactiveText = formatClaudeUsageInteractiveFrame(report, {}, { stream: { isTTY: false, columns: 140 } });

    assert.match(staticText, warning);
    assert.match(interactiveText, warning);
  });

  it("does not start interactive display for reports without usage rows", async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (raw) => { stdin.isRaw = raw; };
    const stdout = {
      isTTY: true,
      columns: 120,
      rows: 40,
      text: "",
      write(chunk) { this.text += String(chunk); },
    };
    const emptyReport = {
      path: "/tmp/empty-session.jsonl",
      rows: [],
      totals: { input: 0, output: 0, cacheRead: 0, cost: 0 },
      grandTotals: { input: 0, output: 0, cacheRead: 0, cost: 0 },
      grandRequests: 0,
      subagents: [],
      estimated: false,
    };

    assert.equal(hasClaudeUsageRows(emptyReport), false);
    assert.equal(await runClaudeUsageInteractiveDisplay(emptyReport, { stdin, stream: stdout }), false);
    assert.equal(stdout.text, "");
    assert.equal(stdin.isRaw, false);
  });

  it("formats every session breakdown before the N-session summary", () => {
    const reportGroup = {
      sessions: [
        {
          path: "/tmp/33333333-3333-4333-9333-333333333333.jsonl",
          sessionName: "Newest session",
          requests: 1,
          rows: [{
            model: "accounts/fireworks/models/glm-5p2",
            displayModel: "glm-5p2",
            input: 0,
            output: 1_000_000,
            cacheRead: 0,
            cost: 4.4,
          }],
          totals: { input: 0, output: 1_000_000, cacheRead: 0, cost: 4.4 },
          grandTotals: { input: 0, output: 1_000_000, cacheRead: 0, cost: 4.4 },
          grandRequests: 1,
          subagents: [],
          estimated: false,
        },
        {
          path: "/tmp/22222222-2222-4222-9222-222222222222.jsonl",
          sessionName: "Middle session",
          requests: 1,
          rows: [{
            model: "accounts/fireworks/models/glm-5p2",
            displayModel: "glm-5p2",
            input: 1_000_000,
            output: 0,
            cacheRead: 0,
            cost: 1.4,
          }],
          totals: { input: 1_000_000, output: 0, cacheRead: 0, cost: 1.4 },
          grandTotals: { input: 1_000_000, output: 0, cacheRead: 0, cost: 1.4 },
          grandRequests: 1,
          subagents: [],
          estimated: false,
        },
      ],
      grandTotals: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cost: 5.8 },
      grandRequests: 2,
      estimated: false,
      lastN: 2,
      requestedLastN: 2,
      sessionCount: 2,
    };

    const text = formatClaudeUsageReportsSummaryDisplay(reportGroup, { stream: { isTTY: false } });
    assert.match(text, /nexus usage · session 1 of 2/);
    assert.match(text, /nexus usage · session 2 of 2/);
    assert.match(text, /nexus usage · last 2 sessions/);
    assert.match(text, /\$5\.80/);
    assert.match(text, /SESSION\s+COST\s+CALLS\s+SHARE\s+%/);
    assert.match(text, /▸ 33333333 Newest session/);
    assert.match(text, /▸ 22222222 Middle session/);
    assert.match(text, /76%/);
    assert.match(text, /24%/);
    assert.match(text, /▾ 33333333\s+Newest session/);
    assert.match(text, /▾ 22222222\s+Middle session/);
    assert.equal(text.match(/MODEL\s+COST\s+SHARE\s+%/g)?.length, 2);
    assert.equal(text.match(/glm-5p2/g)?.length, 2);
    const firstDetail = text.indexOf("nexus usage · session 1 of 2");
    const secondDetail = text.indexOf("nexus usage · session 2 of 2");
    const combinedSummary = text.indexOf("nexus usage · last 2 sessions");
    assert.ok(firstDetail < secondDetail && secondDetail < combinedSummary);
    assert.match(text.slice(combinedSummary), /\$5\.80[\s\S]*2[\s\S]*2[\s\S]*1M in · 1M out/);
    assert.doesNotMatch(text, /================ start session/);
  });

  it("renders interactive frames from session summary to model split to request rows", () => {
    const reportGroup = {
      sessions: [
        {
          path: "/tmp/33333333-3333-4333-9333-333333333333.jsonl",
          sessionName: "Auth retry work",
          rows: [{
            model: "accounts/fireworks/models/glm-5p2",
            displayModel: "glm-5p2",
            input: 100,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            output: 20,
            cacheRead: 30,
            cost: 0.30,
          }],
          totals: { input: 100, cacheWrite5m: 0, cacheWrite1h: 0, output: 20, cacheRead: 30, cost: 0.30 },
          grandTotals: { input: 105, cacheWrite5m: 11, cacheWrite1h: 13, output: 27, cacheRead: 47, cost: 0.50 },
          grandRequests: 2,
          subagents: [{
            id: "alpha",
            rows: [{
              model: "claude-opus-4-8",
              displayModel: "claude-opus-4-8",
              input: 5,
              cacheWrite5m: 11,
              cacheWrite1h: 13,
              output: 7,
              cacheRead: 17,
              cost: 0.20,
            }],
            totals: { input: 5, cacheWrite5m: 11, cacheWrite1h: 13, output: 7, cacheRead: 17, cost: 0.20 },
          }],
        },
        {
          path: "/tmp/22222222-2222-4222-9222-222222222222.jsonl",
          sessionName: "Quick follow-up",
          rows: [{
            model: "accounts/fireworks/models/glm-5p2",
            displayModel: "glm-5p2",
            input: 1,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            output: 1,
            cacheRead: 0,
            cost: 0.10,
          }],
          grandTotals: { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, output: 1, cacheRead: 0, cost: 0.10 },
          grandRequests: 1,
          subagents: [],
        },
      ],
      grandTotals: { input: 106, cacheWrite5m: 11, cacheWrite1h: 13, output: 28, cacheRead: 47, cost: 0.60 },
      grandRequests: 3,
      estimated: false,
    };

    const collapsed = formatClaudeUsageInteractiveFrame(reportGroup, {}, { stream: { isTTY: false, columns: 140 } });
    assert.match(collapsed, /nexus usage · last 2 sessions/);
    assert.match(collapsed, /Cost estimate:/);
    assert.match(collapsed, /Fireworks-served model estimate per request: \(input \* input rate/);
    assert.match(collapsed, /Anthropic model usage is fetched from session logs; estimated cost is calculated from local rates/);
    assert.match(collapsed, /\*\*\*All pricing shown below are estimates based on token usage/);
    assert.match(collapsed, /▸ 33333333 Auth retry work/);
    assert.match(collapsed, /▸ 22222222 Quick follow-up/);
    assert.doesNotMatch(collapsed, /show all/);
    assert.doesNotMatch(collapsed, /NAME\s+Auth retry work/);

    const expanded = formatClaudeUsageInteractiveFrame(reportGroup, {
      focusIndex: 0,
      expandedSessionId: "33333333-3333-4333-9333-333333333333",
    }, { stream: { isTTY: false, columns: 140 } });
    assert.match(expanded, /▾ 33333333 Auth retry work/);
    assert.match(expanded, /NAME\s+Auth retry work/);
    assert.match(expanded, /glm-5p2/);
    assert.match(expanded, /claude-opus-4-8/);
    assert.match(expanded, /▸ show 2 source\/model rows/);
    assert.doesNotMatch(expanded, /REQ\s+SOURCE\s+MODEL/);

    const detailed = formatClaudeUsageInteractiveFrame(reportGroup, {
      focusIndex: 0,
      expandedSessionId: "33333333-3333-4333-9333-333333333333",
      detailSessionId: "33333333-3333-4333-9333-333333333333",
    }, { stream: { isTTY: false, columns: 140 } });
    assert.match(detailed, /NAME\s+Auth retry work/);
    assert.match(detailed, /▾ hide 2 source\/model rows/);
    assert.match(detailed, /SESSION MODEL \/ SUB-AGENT\s+MODEL\s+CALLS\s+INPUT\s+5M WRITE\s+1H WRITE\s+CACHE RD\s+OUTPUT\s+COST/);
    assert.match(detailed, /parent\s+glm-5p2\s+1\s+100\s+0\s+0\s+30\s+20\s+0\.30/);
    assert.match(detailed, /sub-agent alpha\s+claude-opus-4-8\s+1\s+5\s+11\s+13\s+17\s+7\s+0\.20/);
    assert.match(detailed, /TOTAL\s+2\s+105\s+11\s+13\s+47\s+27\s+0\.50/);
    assert.doesNotMatch(detailed, /REQ\s+SOURCE\s+MODEL/);

    const requests = formatClaudeUsageInteractiveFrame(reportGroup, {
      focusIndex: 0,
      expandedSessionId: "33333333-3333-4333-9333-333333333333",
      detailSessionId: "33333333-3333-4333-9333-333333333333",
      requestSource: "alpha",
    }, { stream: { isTTY: false, columns: 140 } });
    assert.match(requests, /NAME\s+Auth retry work/);
    assert.match(requests, /requests for sub-agent alpha/);
    assert.match(requests, /REQ\s+SOURCE\s+MODEL\s+INPUT\s+5M WRITE\s+1H WRITE\s+CACHE RD\s+OUTPUT\s+COST/);
    assert.match(requests, /#1\s+sub-agent alpha\s+claude-opus-4-8\s+5\s+11\s+13\s+17\s+7\s+0\.20/);
    assert.match(requests, /TOTAL sub-agent alpha\s+5\s+11\s+13\s+17\s+7\s+0\.20/);
  });

  it("keeps unpriced costs unknown in source rows and interactive notes", () => {
    const sessionId = "44444444-4444-4444-9444-444444444444";
    const report = {
      path: `/tmp/${sessionId}.jsonl`,
      rows: [
        {
          model: "accounts/fireworks/models/glm-5p3",
          displayModel: "glm-5p3",
          input: 10,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 1,
          cacheRead: 0,
          cost: 0.01,
        },
        {
          model: "accounts/fireworks/models/glm-5p3",
          displayModel: "glm-5p3",
          input: 20,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 2,
          cacheRead: 0,
          cost: null,
          priced: false,
        },
      ],
      totals: { input: 30, cacheWrite5m: 0, cacheWrite1h: 0, output: 3, cacheRead: 0, cost: null },
      grandTotals: { input: 30, cacheWrite5m: 0, cacheWrite1h: 0, output: 3, cacheRead: 0, cost: null },
      grandRequests: 2,
      subagents: [],
      estimated: false,
      unpriced: 1,
    };

    const text = formatClaudeUsageInteractiveFrame(report, {
      expandedSessionId: sessionId,
      detailSessionId: sessionId,
    }, { stream: { isTTY: false, columns: 140 } });

    assert.match(text, /parent\s+glm-5p3\s+2\s+30\s+0\s+0\s+0\s+3\s+n\/a/);
    assert.match(text, /TOTAL\s+2\s+30\s+0\s+0\s+0\s+3\s+n\/a/);
    assert.match(text, /Some calls have no rate available; their cost reads n\/a/);
    assert.doesNotMatch(text, /parent\s+glm-5p3[\s\S]*\$0\.00/);
  });

  it("drills into interactive usage with right arrow and exits with q", async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (raw) => { stdin.isRaw = raw; };
    const stdout = {
      isTTY: true,
      columns: 100,
      rows: 40,
      text: "",
      write(chunk) { this.text += String(chunk); },
    };
    const report = {
      path: "/tmp/33333333-3333-4333-9333-333333333333.jsonl",
      rows: [{
        model: "accounts/fireworks/models/glm-5p2",
        displayModel: "glm-5p2",
        input: 100,
        cacheWrite5m: 4,
        cacheWrite1h: 5,
        output: 20,
        cacheRead: 6,
        cost: 0.30,
      }],
      totals: { input: 100, cacheWrite5m: 4, cacheWrite1h: 5, output: 20, cacheRead: 6, cost: 0.30 },
      grandTotals: { input: 100, cacheWrite5m: 4, cacheWrite1h: 5, output: 20, cacheRead: 6, cost: 0.30 },
      grandRequests: 1,
      subagents: [],
      estimated: false,
    };

    const pending = runClaudeUsageInteractiveDisplay(report, { stdin, stream: stdout });
    stdin.write("\x1b[C");
    stdin.write("\x1b[C");
    stdin.write("\x1b[C");
    stdin.write("q");
    assert.equal(await pending, true);
    assert.match(stdout.text, /requests for parent/);
    assert.match(stdout.text, /REQ\s+SOURCE\s+MODEL\s+INPUT\s+5M WRITE\s+1H WRITE\s+CACHE RD\s+OUTPUT\s+COST/);
    assert.equal(stdin.isRaw, false);
  });

  it("handles arrow key escape sequences split across stdin chunks", async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (raw) => { stdin.isRaw = raw; };
    const stdout = {
      isTTY: true,
      columns: 100,
      rows: 40,
      text: "",
      write(chunk) { this.text += String(chunk); },
    };
    const reportGroup = {
      sessions: [
        {
          path: "/tmp/33333333-3333-4333-9333-333333333333.jsonl",
          rows: [{
            model: "accounts/fireworks/models/glm-5p2",
            displayModel: "glm-5p2",
            input: 100,
            output: 20,
            cacheRead: 0,
            cost: 0.30,
          }],
          grandTotals: { input: 100, output: 20, cacheRead: 0, cost: 0.30 },
          grandRequests: 1,
          subagents: [],
        },
        {
          path: "/tmp/22222222-2222-4222-9222-222222222222.jsonl",
          rows: [{
            model: "claude-opus-4-8",
            displayModel: "claude-opus-4-8",
            input: 10,
            output: 5,
            cacheRead: 0,
            cost: 0.20,
          }],
          grandTotals: { input: 10, output: 5, cacheRead: 0, cost: 0.20 },
          grandRequests: 1,
          subagents: [],
        },
      ],
      grandTotals: { input: 110, output: 25, cacheRead: 0, cost: 0.50 },
      grandRequests: 2,
      estimated: false,
    };

    const pending = runClaudeUsageInteractiveDisplay(reportGroup, { stdin, stream: stdout });
    stdin.write("\x1b");
    stdin.write("[B");
    stdin.write("\x1b");
    stdin.write("[C");
    stdin.write("q");
    assert.equal(await pending, true);
    assert.match(stdout.text, /▾ 22222222/);
    assert.match(stdout.text, /claude-opus-4-8/);
    assert.equal(stdin.isRaw, false);
  });

  for (const [keyName, keySequence] of [["down arrow", "\x1b[B"], ["j", "j"]]) {
    it(`clears expanded session state when moving focus with ${keyName}`, async () => {
      const stdin = new PassThrough();
      stdin.isTTY = true;
      stdin.isRaw = false;
      stdin.setRawMode = (raw) => { stdin.isRaw = raw; };
      const stdout = {
        isTTY: true,
        columns: 120,
        rows: 60,
        text: "",
        write(chunk) { this.text += String(chunk); },
      };
      const reportGroup = {
        sessions: [
          {
            path: "/tmp/33333333-3333-4333-9333-333333333333.jsonl",
            rows: [{
              model: "first-expanded-model",
              displayModel: "first-expanded-model",
              input: 100,
              output: 20,
              cacheRead: 0,
              cost: 0.30,
            }],
            grandTotals: { input: 100, output: 20, cacheRead: 0, cost: 0.30 },
            grandRequests: 1,
            subagents: [],
          },
          {
            path: "/tmp/22222222-2222-4222-9222-222222222222.jsonl",
            rows: [{
              model: "second-collapsed-model",
              displayModel: "second-collapsed-model",
              input: 10,
              output: 5,
              cacheRead: 0,
              cost: 0.20,
            }],
            grandTotals: { input: 10, output: 5, cacheRead: 0, cost: 0.20 },
            grandRequests: 1,
            subagents: [],
          },
        ],
        grandTotals: { input: 110, output: 25, cacheRead: 0, cost: 0.50 },
        grandRequests: 2,
        estimated: false,
      };

      const pending = runClaudeUsageInteractiveDisplay(reportGroup, { stdin, stream: stdout });
      stdin.write("\x1b[C");
      stdin.write(keySequence);
      stdin.write("q");
      assert.equal(await pending, true);

      const frame = lastInteractiveFrame(stdout.text);
      assert.match(frame, /▸ 33333333/);
      assert.match(frame, /▸ 22222222/);
      assert.doesNotMatch(frame, /▾ 33333333/);
      assert.doesNotMatch(frame, /first-expanded-model/);
      assert.equal(stdin.isRaw, false);
    });
  }

  it("ignores PageUp and PageDown when the active drilldown already fits", async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (raw) => { stdin.isRaw = raw; };
    const stdout = {
      isTTY: true,
      columns: 140,
      rows: 80,
      text: "",
      write(chunk) { this.text += String(chunk); },
    };
    const report = {
      path: "/tmp/33333333-3333-4333-9333-333333333333.jsonl",
      rows: [{
        model: "accounts/fireworks/models/glm-5p2",
        displayModel: "glm-5p2",
        input: 100,
        cacheWrite5m: 4,
        cacheWrite1h: 5,
        output: 20,
        cacheRead: 6,
        cost: 0.30,
      }],
      totals: { input: 100, cacheWrite5m: 4, cacheWrite1h: 5, output: 20, cacheRead: 6, cost: 0.30 },
      grandTotals: { input: 110, cacheWrite5m: 4, cacheWrite1h: 5, output: 25, cacheRead: 6, cost: 0.50 },
      grandRequests: 2,
      subagents: [{
        id: "alpha",
        rows: [{
          model: "claude-opus-4-8",
          displayModel: "claude-opus-4-8",
          input: 10,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 5,
          cacheRead: 0,
          cost: 0.20,
        }],
      }],
      estimated: false,
    };

    const pending = runClaudeUsageInteractiveDisplay(report, { stdin, stream: stdout });
    stdin.write("\x1b[C");
    stdin.write("\x1b[C");
    const layer3TextLength = stdout.text.length;
    stdin.write("\x1b[5~");
    stdin.write("\x1b[6~");
    assert.equal(stdout.text.length, layer3TextLength);

    stdin.write("\x1b[C");
    const layer4TextLength = stdout.text.length;
    stdin.write("\x1b[5~");
    stdin.write("\x1b[6~");
    assert.equal(stdout.text.length, layer4TextLength);

    stdin.write("q");
    assert.equal(await pending, true);
    assert.equal(stdin.isRaw, false);
  });

  it("uses PageDown in layer 3 and layer 4", async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (raw) => { stdin.isRaw = raw; };
    const stdout = {
      isTTY: true,
      columns: 140,
      rows: 80,
      text: "",
      write(chunk) { this.text += String(chunk); },
    };
    const requestRows = Array.from({ length: 80 }, (_, index) => ({
      model: "claude-opus-4-8",
      displayModel: "claude-opus-4-8",
      input: index + 1,
      output: index + 2,
      cacheRead: 0,
      cost: 0.10 + index,
    }));
    const subagents = Array.from({ length: 60 }, (_, index) => ({
      id: `agent-${String(index).padStart(2, "0")}`,
      rows: requestRows,
    }));
    const report = {
      path: "/tmp/33333333-3333-4333-9333-333333333333.jsonl",
      rows: [{
        model: "accounts/fireworks/models/glm-5p2",
        displayModel: "glm-5p2",
        input: 1,
        output: 1,
        cacheRead: 0,
        cost: 0.01,
      }],
      grandTotals: { input: 37, output: 45, cacheRead: 0, cost: 28.81 },
      grandRequests: 9,
      subagents,
      estimated: false,
    };

    const pending = runClaudeUsageInteractiveDisplay(report, { stdin, stream: stdout });
    stdin.write("\x1b[C");
    stdin.write("\x1b[C");
    stdin.write("\x1b[6~");
    stdin.write("\x1b[C");
    stdin.write("\x1b[6~");
    stdin.write("\x1b[6~");
    stdin.write("\x1b[6~");
    stdin.write("\x1b[6~");
    stdin.write("\x1b[6~");
    stdin.write("\x1b[6~");
    stdin.write("\x1b[6~");
    stdin.write("q");
    assert.equal(await pending, true);
    assert.match(stdout.text, /requests for sub-agent agent-\d\d/);
    assert.match(stdout.text, /#80\s+sub-agent agent-\d\d\s+claude-opus-4-8/);
    assert.equal(stdin.isRaw, false);
  });

  it("scrolls request rows in a bounded layer 4 viewport", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      model: "accounts/fireworks/models/glm-5p2",
      displayModel: "glm-5p2",
      input: index + 1,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: index + 10,
      cacheRead: index,
      cost: 0.01 * (index + 1),
    }));
    const report = {
      path: "/tmp/33333333-3333-4333-9333-333333333333.jsonl",
      rows,
      totals: { input: 36, cacheWrite5m: 0, cacheWrite1h: 0, output: 108, cacheRead: 28, cost: 0.36 },
      grandTotals: { input: 36, cacheWrite5m: 0, cacheWrite1h: 0, output: 108, cacheRead: 28, cost: 0.36 },
      grandRequests: 8,
      subagents: [],
      estimated: false,
    };
    const state = {
      focusIndex: 0,
      expandedSessionId: "33333333-3333-4333-9333-333333333333",
      detailSessionId: "33333333-3333-4333-9333-333333333333",
      requestSource: "parent",
    };

    const firstPage = formatClaudeUsageInteractiveFrame(report, state, { stream: { isTTY: false, columns: 140, rows: 20 } });
    assert.match(firstPage, /#1\s+parent\s+glm-5p2\s+1\s+0\s+0\s+0\s+10\s+0\.01/);
    assert.doesNotMatch(firstPage, /#8\s+parent\s+glm-5p2/);
    assert.match(firstPage, /TOTAL parent\s+36\s+0\s+0\s+28\s+108\s+0\.36/);
    assert.match(firstPage, /rows 1-\d+ of 8 · ↑\/↓ scroll · PgUp\/PgDn page · ← back · q quit/);

    const lastPage = formatClaudeUsageInteractiveFrame(report, { ...state, requestScrollOffset: 99 }, { stream: { isTTY: false, columns: 140, rows: 20 } });
    assert.doesNotMatch(lastPage, /#1\s+parent\s+glm-5p2/);
    assert.match(lastPage, /#8\s+parent\s+glm-5p2\s+8\s+0\s+0\s+7\s+17\s+0\.08/);
    assert.match(lastPage, /TOTAL parent\s+36\s+0\s+0\s+28\s+108\s+0\.36/);
    assert.match(lastPage, /rows \d+-8 of 8 · ↑\/↓ scroll · PgUp\/PgDn page · ← back · q quit/);
  });

  it("uses a stacked hero and bounded session row in narrow terminals", () => {
    const report = {
      path: "/tmp/12345678-1234-4234-9234-123456789abc.jsonl",
      rows: [{ model: "glm", input: 10, output: 5, cacheRead: 0, cost: 1 }],
      grandTotals: { input: 10, output: 5, cacheRead: 0, cost: 1 },
      grandRequests: 1,
      subagents: [],
      estimated: false,
    };
    const text = formatClaudeUsageSummaryDisplay(report, { stream: { isTTY: false, columns: 44 } });
    const sessionRow = text.split("\n").find((line) => line.startsWith("▾"));
    assert.equal(sessionRow, "▾ 12345678");
    assert.match(text, /TOTAL SPEND\s+\$1\.00/);
    assert.match(text, /TOKENS\s+10 in · 5 out/);
  });

  it("keeps full dated model names aligned in wide terminals", () => {
    const report = {
      path: "/tmp/12345678-1234-4234-9234-123456789abc.jsonl",
      rows: [{
        model: "claude-haiku-4-5-20251001",
        input: 10,
        output: 5,
        cacheRead: 0,
        cost: 1,
      }],
      grandTotals: { input: 10, output: 5, cacheRead: 0, cost: 1 },
      grandRequests: 1,
      subagents: [],
      estimated: false,
    };
    const text = formatClaudeUsageSummaryDisplay(report, { stream: { isTTY: false, columns: 100 } });
    const modelRow = text.split("\n").find((line) => line.includes("claude-haiku"));
    assert.match(modelRow, /claude-haiku-4-5-20251001\s+\$1\.00/);
    assert.equal(modelRow.length, 99);
  });
});
