#!/usr/bin/env node

/**
 * Claude Code `statusLine` helper. Reads the status line JSON on stdin and
 * prints one line: the routed Fireworks model and the session's Fireworks cost.
 *
 * Never exits non-zero and never writes to stderr on a bad payload: Claude Code
 * blanks the status line on failure and logs stderr to the debug log, so a
 * transient unreadable transcript would flicker the line away. Anything we
 * cannot render is simply omitted.
 */

import "../lib/system/legacy-env.mjs";
import process from "node:process";

/*
 * A 'warning' listener must be installed before the imports that can emit one,
 * and must be persistent: process.emitWarning defers to process.nextTick, so a
 * suppress-then-restore window around an import always restores too early.
 * Node's default printer is itself a listener and is not replaced by adding
 * one, hence removeAllListeners first. Status line stderr goes to Claude Code's
 * debug log, so warnings are dropped rather than reprinted.
 */
process.removeAllListeners("warning");
process.on("warning", () => {});

async function readStdin() {
  // Claude Code always writes the payload, but guard against a spawn with no
  // stdin (e.g. someone running the helper by hand) rather than hanging.
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input || typeof input !== "object") {
    return;
  }
  const { renderClaudeStatusLine } = await import("../lib/harnesses/claude/statusline.mjs");
  const line = await renderClaudeStatusLine(input);
  if (line) {
    process.stdout.write(`${line}\n`);
  }
}

main().catch(() => {
  // Silent: an empty status line is better than a broken one.
});
