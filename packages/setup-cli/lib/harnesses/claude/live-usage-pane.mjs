/**
 * Right-hand pane for `nexus claude live`.
 * Waits for the left pane's new Claude session, then execs
 * `nexus claude usage --session`.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { stdin as processStdin } from "node:process";

import {
  killLiveLayout,
} from "./live-tmux.mjs";
import {
  drawLiveWaitingScreen,
  drawSessionLockedScreen,
  enterLiveWaitingScreen,
} from "./live-waiting.mjs";
import { playUsageIntroAnimation } from "./usage/display.mjs";
import {
  findClaudeSessionLog,
  waitForClaudeSessionLog,
  waitForLiveSessionLog,
} from "./usage/report.mjs";

const WAIT_POLL_MS = 250;
const LOCK_HANDOFF_MS = 450;

/**
 * @param {AbortSignal} signal
 * @returns {() => void}
 */
function attachQuitDuringWait(signal) {
  const input = processStdin;
  if (!input.isTTY) {
    return () => {};
  }
  const wasRaw = input.isRaw;
  const onData = (chunk) => {
    const ch = String(chunk);
    if (ch === "q" || ch === "Q" || ch === "\x03") {
      killLiveLayout();
      process.exit(ch === "\x03" ? 130 : 0);
    }
  };
  input.setEncoding("latin1");
  input.resume();
  input.setRawMode(true);
  input.on("data", onData);
  signal.addEventListener("abort", () => {
    input.removeListener("data", onData);
    try {
      input.setRawMode(wasRaw);
    } catch {
      /* noop */
    }
    input.pause();
  }, { once: true });
  return () => {
    input.removeListener("data", onData);
    try {
      input.setRawMode(wasRaw);
    } catch {
      /* noop */
    }
    input.pause();
  };
}

/**
 * @param {string} fireconnectBin absolute path to nexus.mjs
 */
export async function runLiveUsagePane(fireconnectBin) {
  if (!fireconnectBin) {
    throw new Error("nexus binary path is required.");
  }

  const home = process.env.HOME?.trim() ?? "";
  if (!home) {
    throw new Error("HOME is required.");
  }

  const snapshotPath = process.env.FC_LIVE_SNAPSHOT?.trim() ?? "";
  if (!snapshotPath) {
    throw new Error("FC_LIVE_SNAPSHOT is required.");
  }
  // `claude live --session <id>`: the meter locks onto that session directly
  // instead of waiting for a brand-new log, so there is no waiting screen.
  const fixedSession = process.env.FC_LIVE_SESSION?.trim() ?? "";

  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const beforeLogs = snapshot.logs ?? [];
  let tick = 0;
  const restoreWaitingScreen = enterLiveWaitingScreen(process.stdout);
  let sessionPath;

  const waitAbort = new AbortController();
  const detachKeys = attachQuitDuringWait(waitAbort.signal);
  try {
    if (fixedSession) {
      try {
        // Resumed session (`claude live --session`): the log already exists.
        sessionPath = await findClaudeSessionLog({ home, session: fixedSession });
      } catch {
        // Pinned fresh session (`claude --session-id`): its log is written lazily
        // on the first prompt, so wait for that exact id — never a background
        // session that happens to bump its own log.
        if (process.stdout.isTTY) {
          drawLiveWaitingScreen(process.stdout);
        }
        sessionPath = await waitForClaudeSessionLog({
          home,
          session: fixedSession,
          pollMs: WAIT_POLL_MS,
          signal: waitAbort.signal,
        });
      }
    } else {
      // Static waiting screen: draw once, no spinner/repaint loop — it must not
      // read as a "loading" state while the session idles, and constant repaints
      // would wipe any text the user tries to select in the pane.
      if (process.stdout.isTTY) {
        drawLiveWaitingScreen(process.stdout);
      }
      sessionPath = await waitForLiveSessionLog({
        home,
        beforeLogs,
        pollMs: WAIT_POLL_MS,
        signal: waitAbort.signal,
      });
    }
  } finally {
    waitAbort.abort();
    detachKeys();
  }

  const sessionId = path.basename(sessionPath, ".jsonl").slice(0, 8);

  if (process.stdout.isTTY) {
    drawSessionLockedScreen(process.stdout, sessionId, tick);
    tick += 1;
    await playUsageIntroAnimation(process.stdout);
    await new Promise((resolve) => setTimeout(resolve, LOCK_HANDOFF_MS));
  }
  restoreWaitingScreen();

  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fireconnectBin,
      "claude",
      "usage",
      "--session",
      sessionId,
    ], {
      env: {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
        FC_LIVE_SPLIT: "1",
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      if (signal) {
        reject(new Error(`nexus claude usage exited on ${signal}`));
        return;
      }
      resolve(exitCode ?? 0);
    });
  });

  process.exit(Number(code) || 0);
}
