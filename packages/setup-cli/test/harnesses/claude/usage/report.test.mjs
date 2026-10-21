import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeClaudeUsageCost,
  findClaudeSessionLog,
  findClaudeSessionLogs,
  formatClaudeUsageReport,
  formatClaudeUsageReports,
  listTopLevelSessionLogPaths,
  parseClaudeSessionName,
  parseClaudeUsageLog,
  readClaudeUsage,
  readClaudeUsages,
  snapshotLiveSessionLogs,
  usageReportFromText,
  waitForLiveSessionLog,
  waitForNewSessionLog,
} from "../../../../lib/harnesses/claude/usage/report.mjs";
import { runFireconnect } from "../../../helpers.mjs";

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("claude usage", () => {
  it("parses session names from custom-title, summary, and first user prompt", () => {
    assert.equal(parseClaudeSessionName(jsonl([
      { type: "user", message: { role: "user", content: "first question about retries" } },
      { type: "summary", summary: "Auto summary" },
      { type: "custom-title", customTitle: "Auth retry work", sessionId: "33333333-3333-4333-9333-333333333333" },
    ])), "Auth retry work");

    assert.equal(parseClaudeSessionName(jsonl([
      { type: "user", message: { role: "user", content: "first question about retries" } },
      { type: "summary", summary: "Auto summary" },
    ])), "Auto summary");

    assert.equal(parseClaudeSessionName(jsonl([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "first question about retries" }] } },
      { type: "assistant", message: { id: "msg_1", model: "accounts/fireworks/models/glm-5p2", usage: { input_tokens: 1, output_tokens: 1 } } },
    ])), "first question about retries");

    assert.equal(parseClaudeSessionName(jsonl([
      { type: "custom-title", customTitle: "Old name" },
      { type: "custom-title", customTitle: "Renamed later" },
    ])), "Renamed later");
  });

  it("dedupes repeated assistant log lines by message id", () => {
    const text = jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 48_030, cache_read_input_tokens: 8, output_tokens: 11 },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 48_030, cache_read_input_tokens: 8, output_tokens: 11 },
        },
      },
    ]);

    const rows = parseClaudeUsageLog(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].displayModel, "glm-5p2");
    assert.equal(rows[0].input, 48_030);
  });

  it("keeps the richest usage payload when a message id repeats", () => {
    // Claude Code writes one record per content block under a single
    // message.id, and only the LAST carries real usage. Keeping the first
    // priced whole subagent logs at $0.00.
    const text = jsonl([
      { type: "user", message: { role: "user", content: "go" } },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 7_023, cache_read_input_tokens: 92_799, output_tokens: 361 },
        },
      },
    ]);

    const rows = parseClaudeUsageLog(text);
    assert.equal(rows.length, 1, "one API call, not one row per content block");
    assert.equal(rows[0].input, 7_023);
    assert.equal(rows[0].cacheRead, 92_799);
    assert.equal(rows[0].output, 361);
    assert.ok(rows[0].cost > 0, "a call with real tokens must not price at zero");
  });

  it("counts distinct calls separately and preserves log order", () => {
    const text = jsonl([
      {
        type: "assistant",
        message: { id: "msg_a", model: "accounts/fireworks/models/glm-5p2", usage: { input_tokens: 0 } },
      },
      {
        type: "assistant",
        message: { id: "msg_b", model: "accounts/fireworks/models/glm-5p2", usage: { input_tokens: 500 } },
      },
      {
        type: "assistant",
        message: { id: "msg_a", model: "accounts/fireworks/models/glm-5p2", usage: { input_tokens: 100 } },
      },
    ]);

    const rows = parseClaudeUsageLog(text);
    assert.equal(rows.length, 2);
    // msg_a was seen first, so its revised row stays in slot 0.
    assert.equal(rows[0].input, 100);
    assert.equal(rows[1].input, 500);
  });

  it("weighs structured cache_creation when picking the richest payload", () => {
    // Cache writes arrive either flat or as a 5m/1h object. Counting only the
    // flat field let a stale old-format record outweigh the one that actually
    // carried the write tokens.
    const text = jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 100,
            output_tokens: 30,
          },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation: { ephemeral_5m_input_tokens: 200 },
            cache_creation_input_tokens: 0,
            output_tokens: 30,
          },
        },
      },
    ]);

    const rows = parseClaudeUsageLog(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cacheWrite5m, 200, "the structured record carries the real write count");
  });

  it("ignores <synthetic> placeholder records", () => {
    // Interrupts and local slash commands emit a `<synthetic>` model with an
    // all-zero payload; it is not a billable call and must not become a model.
    const text = jsonl([
      { type: "assistant", message: { id: "msg_s", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: "assistant", message: { id: "msg_1", model: "accounts/fireworks/models/glm-5p2", usage: { input_tokens: 10 } } },
    ]);

    const rows = parseClaudeUsageLog(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].displayModel, "glm-5p2");
  });

  it("does not collapse records that share an empty message id", () => {
    // `??` would treat "" as present and bucket every such record together.
    const text = jsonl([
      { type: "assistant", message: { id: "", model: "accounts/fireworks/models/glm-5p2", usage: { input_tokens: 10 } } },
      { type: "assistant", message: { id: "", model: "accounts/fireworks/models/glm-5p2", usage: { input_tokens: 20 } } },
    ]);

    const rows = parseClaudeUsageLog(text);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].input + rows[1].input, 30);
  });

  it("recognizes stored short refs as Fireworks usage", () => {
    const row = computeClaudeUsageCost("deepseek-v4-flash", {
      input_tokens: 1_000_000,
    });
    assert.equal(row.displayModel, "deepseek-v4-flash");
    assert.equal(row.fireworks, true);
    assert.equal(row.cost, 0.22);
    assert.equal(row.estimated, false);
  });

  it("reports no cost at all for a model it has no rate for", () => {
    // providerListPricing answers for any id — an unknown one gets an estimated
    // Sonnet reference — so the Anthropic table must only be consulted for ids
    // that actually name an Anthropic model. With no rate anywhere the call is
    // unpriced: null, never a reference figure and never a free-looking 0.
    const row = computeClaudeUsageCost("accounts/fireworks/models/some-unlisted-model", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    assert.equal(row.cost, null);
    assert.equal(row.priced, false);
    assert.equal(row.rates, null);
    assert.equal(row.estimated, false);
    // The tokens are still real and still reported.
    assert.equal(row.input, 1_000_000);
  });

  it("leaves a total unknown when any call in it is unpriced", () => {
    // Summing an unknown as 0 would hand back a number that reads complete while
    // silently omitting part of the session.
    const text = jsonl([
      { type: "assistant", message: { id: "m1", model: "accounts/fireworks/models/deepseek-v4-flash", usage: { input_tokens: 1_000_000 } } },
      { type: "assistant", message: { id: "m2", model: "accounts/fireworks/models/some-unlisted-model", usage: { input_tokens: 1_000_000 } } },
    ]);
    const report = usageReportFromText("/tmp/session.jsonl", text);
    assert.equal(report.rows.length, 2);
    assert.equal(report.unpriced, 1);
    assert.equal(report.totals.cost, null);
  });

  it("names the unpriced models in the report instead of printing a cost", () => {
    const text = jsonl([
      { type: "assistant", message: { id: "m1", model: "accounts/fireworks/models/some-unlisted-model", usage: { input_tokens: 1_000 } } },
    ]);
    const report = {
      ...usageReportFromText("/tmp/session.jsonl", text),
      subagents: [],
      grandRequests: 1,
    };
    report.grandTotals = report.totals;
    const verbose = formatClaudeUsageReport(report, { verbose: true });
    assert.match(verbose, /Grand total cost: n\/a/, verbose);
    assert.match(verbose, /no rate available/, verbose);
    assert.match(verbose, /some-unlisted-model/, verbose);
    assert.doesNotMatch(verbose, /Grand total cost: \$/, verbose);
  });

  it("still prices Anthropic models from the Anthropic list", () => {
    const row = computeClaudeUsageCost("claude-sonnet-5", { input_tokens: 1_000_000 });
    assert.equal(row.fireworks, false);
    assert.equal(row.estimated, false);
    assert.equal(row.cost, 2);
  });

  it("prices GPT-6 Astra legs from the OpenAI list, short tier", () => {
    for (const model of ["gpt-6-astra", "firerouter/astra"]) {
      const row = computeClaudeUsageCost(model, {
        input_tokens: 42000,
        cache_read_input_tokens: 8000,
        output_tokens: 2500,
      });
      assert.equal(row.priced, true, model);
      assert.equal(row.fireworks, false, model);
      assert.equal(row.estimated, false, model);
      assert.equal(row.rates.label, "GPT-6 Astra", model);
      assert.equal(row.cost, (42000 * 10 + 8000 * 1 + 2500 * 50) / 1_000_000, model);
    }
  });

  it("prices Astra input at the long-context tier once input reaches 272K", () => {
    const row = computeClaudeUsageCost("gpt-6-astra", {
      input_tokens: 300000,
      cache_read_input_tokens: 10000,
      output_tokens: 4000,
    });
    assert.equal(row.priced, true);
    assert.deepEqual(
      {
        input: row.rates.inputPerMillion,
        read: row.rates.cacheReadPerMillion,
        output: row.rates.outputPerMillion,
      },
      { input: 20, read: 2, output: 75 },
    );
    assert.equal(row.cost, (300000 * 20 + 10000 * 2 + 4000 * 75) / 1_000_000);
  });

  it("still withholds cost for OpenAI ids with no list row", () => {
    for (const model of ["gpt-99-future", "gpt-5.6-helios", "o3-mini"]) {
      const row = computeClaudeUsageCost(model, { input_tokens: 1_000_000 });
      assert.equal(row.cost, null, model);
      assert.equal(row.priced, false, model);
      assert.equal(row.rates, null, model);
    }
  });

  it("uses exact published cache rates for Anthropic fast mode", () => {
    const row = computeClaudeUsageCost("claude-opus-5", {
      speed: "fast",
      input_tokens: 100,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 300,
      },
      cache_read_input_tokens: 400,
      output_tokens: 500,
    });
    const expected = (100 * 10 + 200 * 12.5 + 300 * 20 + 400 * 1 + 500 * 50) / 1_000_000;
    assert.equal(row.cost, expected);
    assert.deepEqual(
      {
        input: row.rates.inputPerMillion,
        write5m: row.rates.cacheWrite5mPerMillion,
        write1h: row.rates.cacheWrite1hPerMillion,
        read: row.rates.cacheReadPerMillion,
        output: row.rates.outputPerMillion,
      },
      { input: 10, write5m: 12.5, write1h: 20, read: 1, output: 50 },
    );
  });

  it("prices Fable 5.1 cache reads at the reduced $0.25/Mtok tier", () => {
    const row = computeClaudeUsageCost("claude-fable-5-1", {
      input_tokens: 100,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 500,
    });
    const expected = (100 * 10 + 1_000_000 * 0.25 + 500 * 50) / 1_000_000;
    assert.equal(row.cost, expected);
    assert.equal(row.rates.cacheReadPerMillion, 0.25);
    assert.equal(row.rates.label, "Claude Fable 5.1");
  });

  it("prices Opus 5.5 at its own $4/$20 row, including the [1m] tag", () => {
    const row = computeClaudeUsageCost("claude-opus-5-5[1m]", {
      input_tokens: 100,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 500,
    });
    const expected = (100 * 4 + 1_000_000 * 0.2 + 500 * 20) / 1_000_000;
    assert.equal(row.cost, expected);
    assert.equal(row.rates.label, "Claude Opus 5.5");
  });

  it("computes Anthropic cache write, cache read, geo, batch, and web-search costs", () => {
    const row = computeClaudeUsageCost("claude-opus-4-8", {
      input_tokens: 100,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 300,
      },
      cache_read_input_tokens: 400,
      output_tokens: 500,
      inference_geo: "us",
      service_tier: "batch",
      server_tool_use: { web_search_requests: 2 },
    });

    const tokenCost = (100 * 5 + 200 * 6.25 + 300 * 10 + 400 * 0.5 + 500 * 25) / 1_000_000;
    const expected = tokenCost * 1.1 * 0.5 + 0.02;
    assert.ok(Math.abs(row.cost - expected) < 1e-12);
  });

  it("finds newest top-level session logs under ~/.claude and ignores subagent logs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sessionDir = path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    await mkdir(path.join(sessionDir, "subagents"), { recursive: true });
    const older = path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl");
    const newer = path.join(home, ".claude", "sessions", "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl");
    const subagent = path.join(sessionDir, "subagents", "agent-newer.jsonl");
    await writeFile(older, "\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mkdir(path.dirname(newer), { recursive: true });
    await writeFile(newer, "\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(subagent, "\n");

    assert.equal(await findClaudeSessionLog({ home }), newer);
    assert.equal(await findClaudeSessionLog({ home, session: "aaaaaaaa" }), older);
    assert.equal(await findClaudeSessionLog({ home, session: older }), older);
  });

  it("does not treat a bare session id prefix as a local file path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-prefix-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sessionLog = path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl");
    await writeFile(sessionLog, "\n");

    const cwd = await mkdtemp(path.join(os.tmpdir(), "fc-usage-cwd-"));
    const localConflict = path.join(cwd, "aaaaaaaa");
    const localJsonl = path.join(cwd, "local.jsonl");
    await writeFile(localConflict, "\n");
    await writeFile(localJsonl, "\n");

    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      assert.equal(await findClaudeSessionLog({ home, session: "aaaaaaaa" }), sessionLog);
      assert.equal(path.basename(await findClaudeSessionLog({ home, session: "local.jsonl" })), "local.jsonl");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("reads and formats the latest N parent session logs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-last-n-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });

    const oldest = path.join(projectDir, "11111111-1111-4111-9111-111111111111.jsonl");
    const middle = path.join(projectDir, "22222222-2222-4222-9222-222222222222.jsonl");
    const newest = path.join(projectDir, "33333333-3333-4333-9333-333333333333.jsonl");
    await writeFile(oldest, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_oldest",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(middle, jsonl([
      {
        type: "user",
        message: { role: "user", content: "middle session prompt" },
      },
      {
        type: "custom-title",
        customTitle: "Middle session",
        sessionId: "22222222-2222-4222-9222-222222222222",
      },
      {
        type: "assistant",
        message: {
          id: "msg_middle",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      },
    ]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(newest, jsonl([
      {
        type: "user",
        message: { role: "user", content: "newest session prompt" },
      },
      {
        type: "custom-title",
        customTitle: "Newest session",
        sessionId: "33333333-3333-4333-9333-333333333333",
      },
      {
        type: "assistant",
        message: {
          id: "msg_newest",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 0, output_tokens: 1_000_000 },
        },
      },
    ]));

    assert.deepEqual(await findClaudeSessionLogs({ home, lastN: 2 }), [newest, middle]);

    const reportGroup = await readClaudeUsages({ home, lastN: 2 });
    assert.equal(reportGroup.sessions.length, 2);
    assert.equal(reportGroup.lastN, 2);
    assert.equal(reportGroup.requestedLastN, 2);
    assert.equal(reportGroup.grandRequests, 2);
    assert.ok(Math.abs(reportGroup.grandTotals.cost - 5.8) < 1e-12);
    assert.equal(reportGroup.sessions[0].sessionName, "Newest session");
    assert.equal(reportGroup.sessions[1].sessionName, "Middle session");

    const text = formatClaudeUsageReports(reportGroup);
    assert.match(text, /nexus usage · last 2 sessions/);
    assert.match(text, /TOTAL SPEND/);
    assert.match(text, /SESSION\s+COST\s+CALLS\s+SHARE\s+%/);
    assert.match(text, /▸ 33333333 Newest session/);
    assert.match(text, /▸ 22222222 Middle session/);
    assert.match(text, /▾ 33333333\s+Newest session/);
    assert.match(text, /▾ 22222222\s+Middle session/);
    assert.ok(text.indexOf("▾ 22222222") < text.indexOf("nexus usage · last 2 sessions"));
    assert.doesNotMatch(text, /11111111-1111-4111-9111-111111111111/);
    assert.match(text, /\$5\.80/);

    const tooMany = await readClaudeUsages({ home, lastN: 5 });
    assert.equal(tooMany.sessions.length, 3);
    assert.equal(tooMany.lastN, 3);
    assert.equal(tooMany.requestedLastN, 5);

    const narrowed = await readClaudeUsages({ home, session: "33333333", lastN: 5 });
    assert.equal(narrowed.sessions.length, 1);
    assert.equal(narrowed.lastN, 1);
    assert.equal(narrowed.requestedLastN, 5);
    assert.equal(narrowed.sessions[0].sessionName, "Newest session");

    const plainText = formatClaudeUsageReports(reportGroup, { plain: true });
    assert.match(plainText, /================ start session 33333333-3333-4333-9333-333333333333 \(Newest session\) ================/);
    assert.match(plainText, /Session name: Newest session/);
    assert.match(plainText, /Usage summary:/);
    assert.match(plainText, /Session totals for last 2 sessions:/);
    assert.match(plainText, /GRAND TOTAL\s+\|\s+2\s+\|\s+1,000,000\s+\|\s+1,000,000\s+\|\s+5\.80/);
    assert.doesNotMatch(plainText, /nexus usage · last 2 sessions/);
    assert.doesNotMatch(plainText, /█/);
  });

  it("omits latest sessions and rows with no usage data", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-empty-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });

    const withData = path.join(projectDir, "11111111-1111-4111-9111-111111111111.jsonl");
    const zeroData = path.join(projectDir, "22222222-2222-4222-9222-222222222222.jsonl");
    const empty = path.join(projectDir, "33333333-3333-4333-9333-333333333333.jsonl");
    await writeFile(withData, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_with_data",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_zero",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(zeroData, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_zero_session",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(empty, "\n");

    const reportGroup = await readClaudeUsages({ home, lastN: 3 });
    assert.equal(reportGroup.sessions.length, 1);
    assert.equal(reportGroup.sessions[0].path, withData);
    assert.equal(reportGroup.sessions[0].requests, 1);
    assert.equal(reportGroup.lastN, 1);
    assert.equal(reportGroup.requestedLastN, 3);

    const text = formatClaudeUsageReports(reportGroup);
    assert.match(text, /▾ 11111111/);
    assert.doesNotMatch(text, /22222222-2222-4222-9222-222222222222/);
    assert.doesNotMatch(text, /33333333-3333-4333-9333-333333333333/);
  });

  it("formats a summary text report by default", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-report-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const logPath = path.join(projectDir, "12345678-1234-4234-9234-123456789abc.jsonl");
    await writeFile(logPath, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000, cache_read_input_tokens: 2_000, output_tokens: 3_000 },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_2",
          model: "claude-opus-4-8",
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ]));

    const report = await readClaudeUsage({ home, session: "12345678" });
    const text = formatClaudeUsageReport(report);
    assert.match(text, /nexus usage · last 1 session/);
    assert.match(text, /TOTAL SPEND/);
    assert.match(text, /▾ 12345678/);
    assert.match(text, /glm-5p2/);
    assert.match(text, /claude-opus-4-8/);
    const glmIndex = text.indexOf("glm-5p2");
    const opusIndex = text.indexOf("claude-opus-4-8");
    assert.ok(glmIndex < opusIndex);
    assert.match(text, /Use -v \/ --verbose for request and sub-agent details/);
    assert.doesNotMatch(text, /Parent\/Sub-agent ID/);
    assert.doesNotMatch(text, /Rates used for models in this session/);
  });

  it("formats an old-style plain summary report when requested", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-plain-report-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sessionId = "12345678-1234-4234-9234-123456789abc";
    await mkdir(path.join(projectDir, sessionId, "subagents"), { recursive: true });
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000, cache_read_input_tokens: 2_000, output_tokens: 3_000 },
        },
      },
    ]));
    await writeFile(path.join(projectDir, sessionId, "subagents", "agent-alpha.jsonl"), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_child",
          model: "claude-opus-4-8",
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ]));

    const report = await readClaudeUsage({ home, session: "12345678" });
    const text = formatClaudeUsageReport(report, { plain: true });
    assert.match(text, /Cost estimate:/);
    assert.match(text, /Session log:/);
    assert.match(text, /Usage summary:/);
    assert.match(text, /Parent\/Sub-agent ID\s+\|\s+Model\s+\|\s+Calls\s+\|\s+Input\s+\|\s+Output\s+\|\s+Cost \(USD\)/);
    assert.match(text, /Parent\s+\|\s+accounts\/fireworks\/models\/glm-5p2\s+\|\s+1\s+\|\s+1,000\s+\|\s+3,000/);
    assert.match(text, /alpha\s+\|\s+claude-opus-4-8\s+\|\s+1\s+\|\s+2\s+\|\s+4/);
    assert.match(text, /Grand requests: 2/);
    assert.doesNotMatch(text, /nexus usage · last 1 session/);
    assert.doesNotMatch(text, /TOTAL SPEND/);
    assert.doesNotMatch(text, /█/);
    assert.doesNotMatch(text, /▾/);
  });

  it("formats a verbose text report with request-level rows and rates", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-verbose-report-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const logPath = path.join(projectDir, "12345678-1234-4234-9234-123456789abc.jsonl");
    await writeFile(logPath, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000, cache_read_input_tokens: 2_000, output_tokens: 3_000 },
        },
      },
    ]));

    const report = await readClaudeUsage({ home, session: "12345678" });
    const text = formatClaudeUsageReport(report, { verbose: true });
    assert.match(text, /Session log:/);
    assert.match(text, /Cost estimate:/);
    assert.match(text, /Reference: https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
    assert.match(text, /Fireworks-served model estimate per request/);
    assert.match(text, /Anthropic model usage is fetched from session logs; estimated cost is calculated from local rates/);
    assert.match(text, /\*\*\*All pricing shown below are estimates based on token usage/);
    assert.match(text, /Usage columns:/);
    assert.match(text, /Request #: request number within this section/);
    assert.match(text, /Input: non-cached input tokens billed at the input rate/);
    assert.match(text, /5m Cache Write: input tokens written to a five-minute prompt cache/);
    assert.match(text, /Cost \(USD\): estimated cost for that request/);
    assert.match(text, /Rates used for models in this session/);
    assert.doesNotMatch(text, /inference_geo/);
    assert.doesNotMatch(text, /Web search requests add/);
    assert.match(text, /glm-5p2/);
    assert.match(text, /\$1\.4\s+\|\s+-\s+\|\s+-\s+\|\s+\$0\.14\s+\|\s+\$4\.4/);
    assert.doesNotMatch(text, /glm-5p2-fast/);
    assert.match(text, /Request #\s+\|\s+Model/);
    assert.match(text, /Requests: 1/);
  });

  it("prints the static no-assistant message for an empty session log", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-empty-cli-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sessionId = "12345678-1234-4234-9234-123456789abc";
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), "\n");

    const result = await runFireconnect(["claude", "usage", "--session", "12345678"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`No assistant entries found in .*${sessionId}\\.jsonl`));
    assert.doesNotMatch(result.stdout, /nexus usage · last 1 session/);
  });

  it("accepts --plain for the non-interactive summary output", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-plain-cli-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "12345678-1234-4234-9234-123456789abc.jsonl"), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000, output_tokens: 2_000 },
        },
      },
    ]));

    const result = await runFireconnect(["claude", "usage", "--session", "12345678", "--plain"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Session log:/);
    assert.match(result.stdout, /Usage summary:/);
    assert.match(result.stdout, /Parent\/Sub-agent ID\s+\|\s+Model\s+\|\s+Calls\s+\|\s+Input\s+\|\s+Output\s+\|\s+Cost \(USD\)/);
    assert.match(result.stdout, /Parent\s+\|\s+accounts\/fireworks\/models\/glm-5p2\s+\|\s+1\s+\|\s+1,000\s+\|\s+2,000/);
    assert.doesNotMatch(result.stdout, /nexus usage · last 1 session/);
    assert.doesNotMatch(result.stdout, /TOTAL SPEND/);
    assert.doesNotMatch(result.stdout, /█/);
    assert.doesNotMatch(result.stdout, /Request #\s+\|\s+Model/);
  });

  it("adds subagent sections for child agent logs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-subagent-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sessionId = "12345678-1234-4234-9234-123456789abc";
    await mkdir(path.join(projectDir, sessionId, "subagents"), { recursive: true });
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_parent",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000, cache_read_input_tokens: 2_000, output_tokens: 3_000 },
        },
      },
    ]));
    await writeFile(path.join(projectDir, sessionId, "subagents", "agent-alpha.jsonl"), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_child",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_child_2",
          model: "claude-opus-4-8",
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ]));
    await writeFile(path.join(projectDir, sessionId, "subagents", "agent-empty.jsonl"), "\n");
    await writeFile(path.join(projectDir, sessionId, "subagents", "agent-zero.jsonl"), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_zero_child",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]));

    const report = await readClaudeUsage({ home, session: "12345678" });
    assert.equal(report.subagents.length, 1);
    assert.equal(report.subagents[0].id, "alpha");
    assert.equal(report.grandRequests, 3);
    assert.ok(report.grandTotals.cost > report.totals.cost);

    const text = formatClaudeUsageReport(report);
    assert.doesNotMatch(text, /---- sub-agent alpha ----/);
    assert.doesNotMatch(text, /sub-agent empty/);
    assert.doesNotMatch(text, /sub-agent zero/);
    assert.match(text, /glm-5p2/);
    assert.match(text, /claude-haiku-4-5/);
    assert.match(text, /claude-opus-4-8/);
    assert.match(text, /1 sub-agent included in model totals/);
    const glmIndex = text.indexOf("glm-5p2");
    const haikuIndex = text.indexOf("claude-haiku-4-5");
    const opusIndex = text.indexOf("claude-opus-4-8");
    assert.ok(glmIndex < haikuIndex);
    assert.ok(haikuIndex < opusIndex);
    assert.doesNotMatch(text, /Sub-agent usage summary:/);
    assert.doesNotMatch(text, /Grand total usage summary:/);
    assert.doesNotMatch(text, /Sub-agent model usage/);
    assert.doesNotMatch(text, /Sub-agent total cost:/);
    assert.doesNotMatch(text, /Grand total cost:/);
  });

  it("is exposed through fireconnect claude usage --json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-cli-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "9b86bac5-1234-4234-9234-123456789abc.jsonl"), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-opus-4-8",
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ]));

    const result = await runFireconnect(["claude", "usage", "--session", "9b86", "--json"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.requests, 1);
    assert.equal(parsed.rows[0].model, "claude-opus-4-8");
    assert.equal(parsed.rows[0].rates.inputPerMillion, 5);
  });
});

describe("waitForNewSessionLog", () => {
  it("returns the first session log that was not in the snapshot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-live-wait-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const existingId = "11111111-1111-4111-8111-111111111111";
    await writeFile(path.join(projectDir, `${existingId}.jsonl`), "\n");

    const beforePaths = await listTopLevelSessionLogPaths(home);
    assert.equal(beforePaths.length, 1);

    let polls = 0;
    const sessionPath = await waitForNewSessionLog({
      home,
      beforePaths,
      pollMs: 0,
      sleep: async () => {
        polls += 1;
        if (polls === 2) {
          const newId = "22222222-2222-4222-8222-222222222222";
          await writeFile(path.join(projectDir, `${newId}.jsonl`), "\n");
        }
      },
    });

    assert.equal(path.basename(sessionPath, ".jsonl"), "22222222-2222-4222-8222-222222222222");
    assert.ok(polls >= 2);
  });
});

describe("waitForLiveSessionLog", () => {
  it("returns a new session log that was not in the snapshot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-live-wait-resume-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const existingId = "11111111-1111-4111-8111-111111111111";
    await writeFile(path.join(projectDir, `${existingId}.jsonl`), "\n");

    const snapshot = await snapshotLiveSessionLogs(home);
    let polls = 0;
    const sessionPath = await waitForLiveSessionLog({
      home,
      beforeLogs: snapshot.logs,
      pollMs: 0,
      sleep: async () => {
        polls += 1;
        if (polls === 2) {
          const newId = "22222222-2222-4222-8222-222222222222";
          await writeFile(path.join(projectDir, `${newId}.jsonl`), "\n");
        }
      },
    });

    assert.equal(path.basename(sessionPath, ".jsonl"), "22222222-2222-4222-8222-222222222222");
  });

  it("returns an existing log when it is resumed and mtime advances", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-live-wait-resume-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const existingId = "11111111-1111-4111-8111-111111111111";
    const existingPath = path.join(projectDir, `${existingId}.jsonl`);
    await writeFile(existingPath, "\n");

    const snapshot = await snapshotLiveSessionLogs(home);
    let polls = 0;
    const sessionPath = await waitForLiveSessionLog({
      home,
      beforeLogs: snapshot.logs,
      pollMs: 0,
      sleep: async () => {
        polls += 1;
        if (polls === 2) {
          await writeFile(existingPath, "{\"type\":\"user\"}\n", { flag: "a" });
        }
      },
    });

    assert.equal(sessionPath, existingPath);
  });
});
