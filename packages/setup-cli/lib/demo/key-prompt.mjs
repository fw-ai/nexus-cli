/**
 * Interactive Anthropic-key prompt for `nexus demo`.
 *
 * When the detected incumbent is Anthropic/Claude but no usable key was found
 * (e.g. the user routes Claude through Fireworks via `nexus`, so
 * `probeClaude` skips it and detection falls back to an estimated Anthropic
 * incumbent), we offer to take a key for a live race instead of silently
 * running a fabricated estimate.
 *
 * Two layers, like the setup form:
 *   - `validateAnthropicKey(key)` — pure, unit-testable (no TTY).
 *   - `promptAnthropicKey` / `confirmYesNo` — thin raw-ANSI stdin shells that
 *     are stream-injectable for tests. Dep-free; reuses ./ansi.mjs.
 *
 * The key is used ephemerally for the run; the orchestrator asks (via
 * `confirmYesNo`) whether to persist it afterward. Non-TTY callers never reach
 * this module (the orchestrator gates on `useTui && !options.yes`).
 */

import process from "node:process";

import {
  BOLD, DIM, CYAN, RED, REVERSE, RESET, HIDE_CURSOR, SHOW_CURSOR,
  CLEAR_LINE,
} from "./ansi.mjs";
import { isAnthropicShapedKey } from "../firerouter/core.mjs";
import { isFireworksKey } from "../keys/key-type.mjs";

/**
 * Pure validator for an entered Anthropic API key.
 * @param {string} key
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateAnthropicKey(key) {
  const trimmed = (key ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "empty" };
  }
  if (!isAnthropicShapedKey(trimmed)) {
    return { ok: false, error: "not an Anthropic key (expected sk-ant-...)" };
  }
  return { ok: true };
}

/**
 * Pure validator for an entered Fireworks API key.
 * @param {string} key
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateFireworksKey(key) {
  const trimmed = (key ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "empty" };
  }
  if (!isFireworksKey(trimmed)) {
    return { ok: false, error: "not a Fireworks key (expected fw_…)" };
  }
  return { ok: true };
}

const MASK = "•";

/**
 * Masked-input prompt for a single API key. Resolves to the entered key, or
 * `{ skipped: true }` if the user pressed Enter empty / Esc / Ctrl-C.
 *
 * Shared by the Anthropic and Fireworks key prompts — only the validator, the
 * input-line label, and the once-printed framing differ. Dep-free raw-ANSI
 * stdin shell, stream-injectable for tests. Non-TTY callers get a skipped
 * result with no key (the orchestrator gates on `useTui`).
 *
 * @param {{
 *   validate: (key: string) => { ok: boolean, error?: string },
 *   label: string,
 *   framing: string[],
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 * }} args
 * @returns {Promise<{ key: string, skipped: boolean }>}
 */
export async function promptMaskedKey({ validate, label, framing, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY) {
    return { key: "", skipped: true };
  }

  // Static framing printed once; the input line below is rewritten in place.
  for (const line of framing) {
    stdout.write(`${line}\n`);
  }

  return new Promise((resolve) => {
    let value = "";
    let error = "";
    let done = false;

    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      if (done) return;
      done = true;
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      stdin.pause();
      stdout.write(SHOW_CURSOR);
      stdout.write(`\r${CLEAR_LINE}\n`);
    };

    const redraw = () => {
      // Masked bullets (BOLD so they're clearly visible) + a live char count so
      // a paste is obviously captured (the raw key is never printed) + a
      // reverse-video block cursor at the input position so the field reads as
      // focused/active instead of dead.
      const bullets = `${BOLD}${MASK.repeat(value.length)}${RESET}`;
      const count = value.length > 0 ? `  ${DIM}(${value.length} chars)${RESET}` : "";
      const cursor = `${REVERSE} ${RESET}`;
      let line = `  ${BOLD}${CYAN}${label}${RESET} ${bullets}${cursor}${count}`;
      if (error) {
        line += `  ${RED}${error}${RESET}`;
      }
      stdout.write(`\r${CLEAR_LINE}${line}`);
    };

    const finish = (result) => {
      cleanup();
      resolve(result);
    };

    const onData = (chunk) => {
      const buf = chunk.toString("latin1");
      let i = 0;
      while (i < buf.length) {
        const ch = buf[i];
        if (ch === "\x03") { // Ctrl-C
          finish({ key: "", skipped: true });
          return;
        }
        if (ch === "\x1b") {
          // Escape, possibly the start of a CSI sequence (arrow keys etc.).
          // Arrow keys arrive as `\x1b[A/B/C/D`; a bare Esc is `\x1b` alone.
          // Treat only a lone Esc as cancel — arrow / other escape sequences
          // are no-ops here (masked input has no cursor navigation), so a
          // stray ↑/↓ doesn't abort the prompt.
          if (i + 1 < buf.length) {
            // There are more bytes in this chunk; if it's a CSI sequence, skip
            // it. Anything else after Esc is also ignored (not a cancel).
            if (buf[i + 1] === "[") {
              // `\x1b[` + a terminator byte (e.g. A/B/C/D for arrows).
              i += 3;
            } else {
              i += 2;
            }
            continue;
          }
          // Lone Esc at the end of the chunk → cancel.
          finish({ key: "", skipped: true });
          return;
        }
        if (ch === "\r" || ch === "\n") { // Enter
          const v = value.trim();
          if (!v) {
            finish({ key: "", skipped: true });
            return;
          }
          const res = validate(v);
          if (res.ok) {
            finish({ key: v, skipped: false });
            return;
          }
          error = res.error;
          value = "";
          redraw();
          return;
        }
        if (ch === "\x7f" || ch === "\x08") { // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
            error = "";
            redraw();
          }
          i += 1;
          continue;
        }
        // Printable byte (the key is ASCII). Ignore others.
        if (ch >= " " && ch <= "~") {
          if (value.length < 200) {
            value += ch;
            error = "";
            redraw();
          }
          i += 1;
          continue;
        }
        // Unrecognized byte (non-ASCII, stray control): consume and ignore.
        i += 1;
      }
    };

    stdout.write(HIDE_CURSOR);
    stdin.setEncoding("latin1");
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
    redraw();
  });
}

/**
 * Prompt for an Anthropic API key with masked input. Resolves to the entered
 * key, or `{ skipped: true }` if the user pressed Enter empty / Esc / Ctrl-C.
 *
 * @param {{
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 * }} [args]
 * @returns {Promise<{ key: string, skipped: boolean }>}
 */
export function promptAnthropicKey({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return promptMaskedKey({
    validate: validateAnthropicKey,
    label: "Anthropic key:",
    framing: [
      `\n  ${BOLD}No Anthropic API key found — no comparison model to race.${RESET}`,
      `  ${DIM}Paste an sk-ant-… key to race Claude live, or press Enter to cancel.${RESET}`,
      `  ${DIM}(Input is masked. Esc or empty Enter skips — no key is sent.)${RESET}`,
    ],
    stdin,
    stdout,
  });
}

/**
 * Prompt for a Fireworks API key with masked input. Resolves to the entered
 * key, or `{ skipped: true }` if the user pressed Enter empty / Esc / Ctrl-C.
 *
 * Used when the challenger has no usable key (none resolved, or the resolved
 * key was rejected as invalid by the pre-flight) — instead of failing the run,
 * we offer to take one for this run only.
 *
 * @param {{
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 * }} [args]
 * @returns {Promise<{ key: string, skipped: boolean }>}
 */
export function promptFireworksKey({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return promptMaskedKey({
    validate: validateFireworksKey,
    label: "Fireworks key:",
    framing: [
      `\n  ${BOLD}No usable Fireworks API key — the challenger can't run live.${RESET}`,
      `  ${DIM}Paste an fw_… key to race it, or press Enter to cancel.${RESET}`,
      `  ${DIM}(Input is masked. Esc or empty Enter skips — no key is sent.)${RESET}`,
    ],
    stdin,
    stdout,
  });
}

/**
 * A y/N confirm (default No, so a key is never surprise-saved to disk).
 * @param {string} label
 * @param {{
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 * }} [args]
 * @returns {Promise<boolean>}
 */
export async function confirmYesNo(label, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY) {
    return false;
  }
  return new Promise((resolve) => {
    let done = false;
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      if (done) return;
      done = true;
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      stdin.pause();
      stdout.write(`\r${CLEAR_LINE}\n`);
    };

    stdout.write(`${DIM}${label}${RESET} ${BOLD}[y/N]${RESET} `);

    const onData = (chunk) => {
      const buf = chunk.toString("latin1");
      for (let i = 0; i < buf.length; i += 1) {
        const ch = buf[i];
        if (ch === "\x03") { // Ctrl-C
          cleanup();
          resolve(false);
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(false); // default No
          return;
        }
        if (ch === "y" || ch === "Y") {
          cleanup();
          resolve(true);
          return;
        }
        if (ch === "n" || ch === "N" || ch === "\x1b") {
          cleanup();
          resolve(false);
          return;
        }
        // ignore other bytes
      }
    };

    stdin.setEncoding("latin1");
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

/**
 * Serve-then-exit gate for the demo's browser handoff.
 *
 * The local static server has to outlive `open <url>` long enough for the
 * browser to fetch compare.html — but a fixed multi-second sleep makes the CLI
 * look hung after it has already printed every result. Hold here under the
 * user's control instead: block until any key (or Ctrl-C, which arrives as a
 * raw byte, not a signal) is pressed, then let the caller close the server and
 * return so the process exits immediately. compare.html inlines both apps, so
 * the page keeps working in the browser after the server is gone.
 *
 * Non-TTY callers resolve immediately (nothing to wait on).
 *
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, message?: string, timeoutMs?: number, minHoldMs?: number }} [args]
 * @returns {Promise<void>}
 */
export function pressAnyKeyToExit({
  stdin = process.stdin,
  stdout = process.stdout,
  message,
  timeoutMs = 0,
  minHoldMs = 0,
} = {}) {
  if (!stdin.isTTY) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let canExit = minHoldMs <= 0;
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      stdin.pause();
      resolve();
    };
    const onData = () => {
      if (!canExit) return;
      cleanup();
    };

    const hint = message || "Press any key to exit — the comparison stays open in your browser.";
    stdout.write(`\n  ${DIM}${hint}${RESET}\n`);
    stdin.resume();
    try { stdin.setRawMode(true); } catch { /* noop */ }
    stdin.on("data", onData);
    if (!canExit) {
      setTimeout(() => { canExit = true; }, minHoldMs);
    }
    // Safety net: resuming stdin holds the event loop open, so an unattended run
    // would wait forever. A timeout resolves the wait (and restores the terminal)
    // exactly like a keypress, guaranteeing the process eventually exits.
    if (timeoutMs > 0) {
      timer = setTimeout(cleanup, timeoutMs);
    }
  });
}

// ── promptChoice: a small numbered menu ──────────────────────────────────────

/**
 * Render a single-select numbered menu and resolve to the chosen option.
 *
 * Mirrors {@link confirmYesNo}: a thin raw-ANSI stdin shell that's
 * stream-injectable for tests. Used by the demo's State-A "you're already on
 * Fireworks" prompt to offer explicit paths instead of a silent fallback.
 *
 * Keys: ↑/↓ move, 1-9 jump, Enter select, q / Esc / Ctrl-C quit.
 *
 * @param {{
 *   title: string,
 *   hint?: string,
 *   options: string[],
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 * }} args
 * @returns {Promise<{ index: number, quit: boolean }>}
 *   `index` is -1 when the user quit without selecting.
 */
export async function promptChoice({ title, hint = "", options, stdin = process.stdin, stdout = process.stdout }) {
  if (!stdin.isTTY) {
    return { index: -1, quit: true };
  }
  if (!Array.isArray(options) || options.length === 0) {
    return { index: -1, quit: true };
  }

  let focus = 0;
  let prevHeight = 0;
  const optionLines = () => options.map((opt, idx) => {
    const selected = idx === focus;
    const num = `${idx + 1}`;
    const body = `${num} ${opt}`;
    return selected ? `  ${CYAN}❯${RESET} ${REVERSE}${BOLD}${body}${RESET}` : `    ${DIM}${body}${RESET}`;
  });

  const render = () => {
    // Repaint in place: move up over the previously drawn block, clear each
    // line, then write the new block. The first paint starts fresh.
    const lines = [`  ${BOLD}${CYAN}${title}${RESET}`];
    if (hint) {
      lines.push(`  ${DIM}${hint}${RESET}`);
    }
    lines.push("");
    lines.push(...optionLines());
    lines.push("");
    lines.push(`  ${DIM}↑/↓ move   1-9 jump   ⏎ select   q quit${RESET}`);

    let out = "";
    if (prevHeight > 0) {
      // Move up prevHeight lines, clear each fully (col 1 → end), descend back.
      out += `\x1b[${prevHeight}A`;
      for (let i = 0; i < prevHeight; i += 1) {
        out += `\r${CLEAR_LINE}\x1b[1B`;
      }
      out += `\x1b[${prevHeight}A`;
    }
    out += lines.join("\n");
    stdout.write(out);
    prevHeight = lines.length;
  };

  stdout.write(HIDE_CURSOR);
  render();

  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    const wasRaw = stdin.isRaw;
    const finish = (result) => {
      if (done) return;
      done = true;
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      stdin.pause();
      stdout.write(SHOW_CURSOR);
      stdout.write(`\r${CLEAR_LINE}\n`);
      resolve(result);
    };

    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      while (buf.length > 0) {
        const ch = buf[0];
        if (ch === "\x03") { // Ctrl-C
          buf = buf.slice(1);
          finish({ index: -1, quit: true });
          return;
        }
        if (ch === "\x1b") {
          // Arrow keys come as ESC [ A/B/C/D. Anything else (bare Esc) quits.
          if (buf.length >= 3 && buf[1] === "[") {
            const arrow = buf[2];
            buf = buf.slice(3);
            if (arrow === "A" || arrow === "D") { // up / left
              focus = (focus - 1 + options.length) % options.length;
            } else if (arrow === "B" || arrow === "C") { // down / right
              focus = (focus + 1) % options.length;
            }
            render();
            continue;
          }
          // Bare Esc — drop pending esc and quit.
          buf = buf.slice(1);
          finish({ index: -1, quit: true });
          return;
        }
        if (ch === "\r" || ch === "\n") { // Enter
          buf = buf.slice(1);
          finish({ index: focus, quit: false });
          return;
        }
        if (ch >= "1" && ch <= "9") {
          const idx = Number(ch) - 1;
          buf = buf.slice(1);
          if (idx < options.length) {
            focus = idx;
            finish({ index: idx, quit: false });
            return;
          }
          // Out of range — just move focus as a visual ack and keep waiting.
          render();
          continue;
        }
        if (ch === "q" || ch === "Q") {
          buf = buf.slice(1);
          finish({ index: -1, quit: true });
          return;
        }
        // Ignore other bytes.
        buf = buf.slice(1);
      }
    };

    stdin.setEncoding("latin1");
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}
