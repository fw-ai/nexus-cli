/**
 * Live cost view for one Claude Code session.
 *
 * On a TTY: live-track Main by default, with every agent in the session listed
 * in a pane that updates as subagents spawn. Tab focuses that pane and
 * ↑/↓/Enter switch which agent is metered; Esc goes back to the session list;
 * q quits. Snapshots stay one-shot for `--json`, `--last-n`, `--verbose`, and
 * non-TTY.
 */

import process, { stdin, stdout } from "node:process";

import {
  attachAgentBackKey,
  promptClaudeUsageAgent,
} from "./agent-picker.mjs";
import { listSessionAgents } from "./agents.mjs";
import { sumCosts } from "./cost.mjs";
import { findClaudeSessionLog } from "./report.mjs";
import { runUsageMeter } from "./meter.mjs";
import { ANSI } from "../../../ui/palette.mjs";

/**
 * Totals for agents other than the one the meter is currently tracking.
 * Null costs stay null: an agent with an unpriceable call has an unknown total,
 * not a free one, and that unknown must reach the session total.
 *
 * @param {any[]} agents
 */
export function summarizePeerAgents(agents) {
  let count = 0;
  let calls = 0;
  /** @type {Array<number | null>} */
  const costs = [];
  /** @type {{ label: string, calls: number, cost: number | null } | null} */
  let main = null;

  for (const agent of agents) {
    const agentCalls = agent.report?.requests ?? 0;
    const agentCost = agent.report?.totals?.cost === undefined
      ? 0
      : agent.report.totals.cost;
    if (agent.kind === "main") {
      main = { label: agent.label || "Main", calls: agentCalls, cost: agentCost };
      continue;
    }
    count += 1;
    calls += agentCalls;
    costs.push(agentCost);
  }
  return {
    count,
    calls,
    cost: sumCosts(costs),
    main,
  };
}

/**
 * Whether `claude usage` should run the live meter rather than a snapshot.
 *
 * `--plain` counts as a snapshot request: it asks for scrapeable output, so
 * taking over the terminal with an interactive session picker is the opposite of
 * what was asked. (`runClaudeUsageLive` also honours `plain` internally, but by
 * then the picker has already drawn.)
 *
 * @param {{ json?: boolean, lastN?: string, verbose?: boolean, plain?: boolean }} ctx
 * @param {{ isTTY?: boolean }} [stream]
 */
export function shouldRunClaudeUsageLive(ctx, stream = stdout) {
  if (ctx.json || ctx.lastN || ctx.verbose || ctx.plain) return false;
  return Boolean(stream?.isTTY);
}

/**
 * Footer key hint for the live meter.
 *
 * Tab focuses the in-frame agents pane and Esc goes back to the session list —
 * but only when one exists.
 *
 * @param {{ canPickSession?: boolean }} [opts]
 */
export function liveMeterKeyHint({ canPickSession = false } = {}) {
  return canPickSession
    ? "Tab agents · Esc sessions · q quit"
    : "Tab agents · q quit";
}

/**
 * Resolve the session, live-track Main, and let ← open the subagent picker.
 *
 * @param {{
 *   home: string,
 *   session?: string,
 *   plain?: boolean,
 *   pollMs?: number,
 *   stream?: NodeJS.WritableStream,
 *   input?: NodeJS.ReadStream,
 *   signal?: AbortSignal,
 *   resolveSession?: typeof findClaudeSessionLog,
 *   listAgents?: typeof listSessionAgents,
 *   sleep?: (ms: number) => Promise<void>,
 *   promptAgent?: typeof promptClaudeUsageAgent,
 *   promptSession?: (opts: { home: string, input?: NodeJS.ReadStream, output?: NodeJS.WriteStream }) => Promise<string | null>,
 * }} opts
 */
export async function runClaudeUsageLive({
  home,
  session = "",
  plain = false,
  pollMs = 250,
  stream = stdout,
  input = stdin,
  signal,
  resolveSession = findClaudeSessionLog,
  listAgents = listSessionAgents,
  sleep,
  promptAgent = promptClaudeUsageAgent,
  promptSession,
} = {}) {
  if (!home) {
    throw new Error("HOME is required to follow Claude Code session usage.");
  }

  let sessionPath = await resolveSession({ home, session });

  // `listAgents` prices every subagent log in the session, so back-to-back
  // callers (find Main, then compute the first frame's peer total) would read
  // the same files twice. Share a result for a beat; the meter's peer refresh
  // runs on a slower cadence than this window, so it still sees fresh figures.
  const AGENTS_TTL_MS = 250;
  /** @type {{ path: string, at: number, promise: Promise<any[]> } | null} */
  let agentsMemo = null;
  const agentsOf = (logPath) => {
    const now = Date.now();
    if (agentsMemo && agentsMemo.path === logPath && now - agentsMemo.at < AGENTS_TTL_MS) {
      return agentsMemo.promise;
    }
    const promise = listAgents(logPath);
    agentsMemo = { path: logPath, at: now, promise };
    // A rejected memo must not be replayed to later callers.
    promise.catch(() => {
      if (agentsMemo?.promise === promise) agentsMemo = null;
    });
    return promise;
  };

  /**
   * Spend of every agent in the session EXCEPT the one being tracked, for the
   * footer's attribution rows. Without it a session whose work happened inside
   * subagents shows a small total and no clue where the money went.
   *
   * Main is reported separately from the subagent tally: while tracking a
   * subagent, folding Main into a "N subagents" row misattributes what is
   * usually the largest spend in the session to the wrong kind of agent.
   *
   * @param {string} selfPath the tracked agent's log
   */
  const peersExcluding = async (selfPath) => {
    const others = (await agentsOf(sessionPath)).filter((agent) => agent.filePath !== selfPath);
    return summarizePeerAgents(others);
  };

  /** Main (or the first agent) of the session at `sessionPath`. */
  const mainAgentOf = async (logPath) => {
    const agents = await agentsOf(logPath);
    const main = agents.find((a) => a.kind === "main") ?? agents[0];
    if (!main) {
      throw new Error(`No agents found for session ${logPath}`);
    }
    return main;
  };

  // Fullscreen meter owns the pane; wipe it before drawing a prompt-tier list.
  const clearPane = () => {
    if (stream && typeof stream.write === "function") {
      stream.write(`${ANSI.clearScreen}${ANSI.homeCursor}${ANSI.showCursor}`);
    }
  };

  // Non-interactive: live-track Main only.
  if (!input?.isTTY || plain) {
    return runUsageMeter({
      filePath: sessionPath,
      plain,
      fromStart: true,
      follow: true,
      pollMs,
      stream,
      signal,
      sleep,
      agentLabel: "Main",
      readPeers: () => peersExcluding(sessionPath),
    });
  }

  let current = await mainAgentOf(sessionPath);
  // Only advertise Esc when there is a picker to go back to. With an explicit
  // --session there is no session list, so the key would lead nowhere.
  const canPickSession = typeof promptSession === "function";
  // Shared with the meter (which renders it) and the key watcher (which moves
  // its cursor), so there is one copy of "which agent is selected" rather than
  // two that can disagree.
  const pane = {
    list: [],
    index: 0,
    focused: false,
    trackingId: current.id,
  };
  // One key per action: Tab focuses the agents pane, Esc goes back to the session
  // list. Arrow keys are the pane cursor's, so they never double as navigation.
  const keyHint = liveMeterKeyHint({ canPickSession });

  for (;;) {
    if (signal?.aborted) return;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let openAgents = false;
    let openSessions = false;
    let quit = false;
    /** @type {any} */
    let picked = null;
    /** @type {(() => void) | null} */
    let repaint = null;
    pane.trackingId = current.id;
    const detach = attachAgentBackKey({
      input,
      output: stream,
      pane,
      // Switching agent means a new tail, so end this meter run and let the loop
      // start the next one — the same path the modal picker used.
      onPick: (agent) => {
        if (!agent || agent.filePath === current.filePath) {
          repaint?.();
          return;
        }
        picked = agent;
        controller.abort();
      },
      onPaneChange: () => repaint?.(),
      onAgents: () => {
        openAgents = true;
        controller.abort();
      },
      onQuit: () => {
        quit = true;
        controller.abort();
      },
      ...(canPickSession
        ? {
          onSessions: () => {
            openSessions = true;
            controller.abort();
          },
        }
        : {}),
    });

    try {
      const db = await runUsageMeter({
        filePath: current.filePath,
        plain,
        fromStart: true,
        follow: true,
        pollMs,
        stream,
        signal: controller.signal,
        sleep,
        agentLabel: current.label,
        readPeers: () => peersExcluding(current.filePath),
        keyHint,
        agentPane: pane,
        readAgents: () => agentsOf(sessionPath),
        // Handed back so a keypress repaints at once instead of waiting out the
        // poll interval, which made pane navigation feel unresponsive.
        onReady: (dashboard) => { repaint = () => dashboard.draw(); },
      });
      // Stop repainting a dashboard whose run has ended.
      repaint = null;
      void db;
    } finally {
      repaint = null;
      detach();
      signal?.removeEventListener("abort", onAbort);
    }

    if (quit) {
      // q is a hard exit. By here the meter's `finally` has exited the alt
      // screen and `detach()` has restored raw mode and paused stdin — but a
      // paused TTY stdin still holds a libuv ref, so returning up the stack
      // just hangs the process (only Ctrl+C, which exits explicitly, ended it).
      // Match that path and exit now that the terminal is restored.
      process.exit(0);
    }
    if (signal?.aborted) {
      return;
    }
    if (picked) {
      current = picked;
      continue;
    }
    if (!openAgents && !openSessions) {
      return;
    }

    clearPane();

    if (openSessions) {
      // Same reasoning as the agent picker below: the session list is rebuilt
      // on open, so an empty lookback window or an unreadable log throws. Esc
      // must not be able to kill a working meter — resume what we were on.
      try {
        const nextSession = await promptSession({ home, input, output: stream });
        // Esc/q out of the session list also resumes the tracked agent.
        if (nextSession == null) {
          continue;
        }
        if (nextSession !== sessionPath) {
          const nextMain = await mainAgentOf(nextSession);
          // Only commit once the new session resolved: a half-applied switch
          // would leave sessionPath pointing at a log `current` isn't part of,
          // so the footer would attribute peers against the wrong session.
          sessionPath = nextSession;
          current = nextMain;
        }
      } catch {
        /* keep tracking the current agent */
      }
      continue;
    }

    // The picker re-lists agents, so a log removed since the meter opened (a
    // cleaned-up subagent, a deleted session) makes it throw. That is a
    // transient view problem, not a reason to kill the meter — resume instead.
    let chosen;
    try {
      chosen = await promptAgent({
        sessionPath,
        input,
        output: stream,
        // Highlight the agent you'd most likely switch TO, so → alone toggles:
        // from Main that's the first live subagent (empty id, resolved inside
        // the picker so subagents spawned during the meter are included); from
        // a subagent it's Main. Highlighting the subagent already being tracked
        // put the cursor on the one row nobody needs, and since Main sits above
        // it in the list, getting back looked impossible without pressing ↑.
        initialId: current.kind === "main" ? "" : "main",
        trackingId: current.id,
        trackingLabel: current.label,
        listAgents,
      });
    } catch {
      continue;
    }

    if (chosen == null) {
      return;
    }
    if (chosen.resume) {
      continue;
    }
    current = chosen;
  }
}
