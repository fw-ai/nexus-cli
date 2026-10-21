import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  validateAnthropicKey,
  validateFireworksKey,
  promptAnthropicKey,
  promptFireworksKey,
  confirmYesNo,
  promptChoice,
  pressAnyKeyToExit,
} from "../../lib/demo/key-prompt.mjs";

// ── fake stdin/stdout ────────────────────────────────────────────────────────

function fakeStdin() {
  const s = new PassThrough();
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = () => {};
  return s;
}

function fakeStdout() {
  const buf = { out: "" };
  return { isTTY: true, write: (str) => { buf.out += str; }, _buf: buf };
}

// ── validateAnthropicKey (pure) ──────────────────────────────────────────────

test("validateAnthropicKey: accepts a well-formed sk-ant key", () => {
  assert.deepEqual(validateAnthropicKey("sk-ant-abc123XYZ"), { ok: true });
});

test("validateAnthropicKey: rejects empty", () => {
  const r = validateAnthropicKey("");
  assert.equal(r.ok, false);
  assert.equal(r.error, "empty");
});

test("validateAnthropicKey: rejects non-Anthropic shapes", () => {
  const r = validateAnthropicKey("fw-abc123");
  assert.equal(r.ok, false);
  assert.match(r.error, /sk-ant/);
});

test("validateAnthropicKey: trims whitespace before checking", () => {
  assert.deepEqual(validateAnthropicKey("  sk-ant-xyz  "), { ok: true });
});

// ── validateFireworksKey (pure) ──────────────────────────────────────────────

test("validateFireworksKey: accepts fw_ prefixed keys", () => {
  assert.deepEqual(validateFireworksKey("fw_abc123XYZ"), { ok: true });
});

test("validateFireworksKey: rejects fpk_ prefixed keys", () => {
  const r = validateFireworksKey("fpk_abc123XYZ");
  assert.equal(r.ok, false);
  assert.match(r.error, /fw_/);
});

test("validateFireworksKey: rejects empty", () => {
  const r = validateFireworksKey("");
  assert.equal(r.ok, false);
  assert.equal(r.error, "empty");
});

test("validateFireworksKey: rejects non-Fireworks shapes", () => {
  const r = validateFireworksKey("sk-ant-abc123");
  assert.equal(r.ok, false);
  assert.match(r.error, /fw_/);
});

test("validateFireworksKey: trims whitespace before checking", () => {
  assert.deepEqual(validateFireworksKey("  fw_xyz  "), { ok: true });
});

// ── promptFireworksKey ───────────────────────────────────────────────────────

test("promptFireworksKey: non-TTY stdin resolves skipped with no key", async () => {
  const stdin = new PassThrough(); // isTTY undefined → falsy
  const stdout = fakeStdout();
  const r = await promptFireworksKey({ stdin, stdout });
  assert.equal(r.skipped, true);
  assert.equal(r.key, "");
});

test("promptFireworksKey: valid pasted key + Enter resolves with it", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const p = promptFireworksKey({ stdin, stdout });
  stdin.write("fw_test123\r");
  const r = await p;
  assert.equal(r.skipped, false);
  assert.equal(r.key, "fw_test123");
  // Mask rendered (•), never the raw key.
  assert.ok(stdout._buf.out.includes("•"));
  assert.doesNotMatch(stdout._buf.out, /fw_test123/);
});

test("promptFireworksKey: invalid input clears and re-prompts, then accepts a valid key", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const p = promptFireworksKey({ stdin, stdout });
  stdin.write("not-a-key\r");
  stdin.write("fw_good\r");
  const r = await p;
  assert.equal(r.skipped, false);
  assert.equal(r.key, "fw_good");
});

test("promptFireworksKey: empty Enter resolves skipped", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const p = promptFireworksKey({ stdin, stdout });
  stdin.write("\r");
  const r = await p;
  assert.equal(r.skipped, true);
  assert.equal(r.key, "");
});

// ── promptAnthropicKey: non-TTY skips ────────────────────────────────────────

test("promptAnthropicKey: non-TTY stdin resolves skipped with no key", async () => {
  const stdin = new PassThrough(); // isTTY undefined → falsy
  const stdout = fakeStdout();
  const r = await promptAnthropicKey({ stdin, stdout });
  assert.equal(r.skipped, true);
  assert.equal(r.key, "");
});

// ── promptAnthropicKey: a valid key piped through resolves with it ───────────

test("promptAnthropicKey: valid pasted key + Enter resolves with the key", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const p = promptAnthropicKey({ stdin, stdout });
  // Simulate a paste of a valid key followed by Enter.
  stdin.write("sk-ant-test123\r");
  const r = await p;
  assert.equal(r.skipped, false);
  assert.equal(r.key, "sk-ant-test123");
  // Mask rendered (•), never the raw key.
  assert.ok(stdout._buf.out.includes("•"));
  assert.doesNotMatch(stdout._buf.out, /sk-ant-test123/);
});

test("promptAnthropicKey: empty Enter resolves skipped", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const p = promptAnthropicKey({ stdin, stdout });
  stdin.write("\r");
  const r = await p;
  assert.equal(r.skipped, true);
  assert.equal(r.key, "");
});

test("promptAnthropicKey: invalid input clears and re-prompts, then accepts a valid key", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const p = promptAnthropicKey({ stdin, stdout });
  // First a bad key + Enter → should not resolve, should show error.
  stdin.write("not-a-key\r");
  // Then a valid key + Enter → resolves.
  stdin.write("sk-ant-good\r");
  const r = await p;
  assert.equal(r.skipped, false);
  assert.equal(r.key, "sk-ant-good");
  // An error hint was rendered at some point.
  assert.match(stdout._buf.out, /sk-ant/);
});

test("promptAnthropicKey: Esc resolves skipped", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const p = promptAnthropicKey({ stdin, stdout });
  stdin.write("sk-ant-");
  stdin.write("\x1b");
  const r = await p;
  assert.equal(r.skipped, true);
  assert.equal(r.key, "");
});

// ── confirmYesNo ─────────────────────────────────────────────────────────────

test("confirmYesNo: non-TTY defaults to false", async () => {
  const stdin = new PassThrough();
  const stdout = fakeStdout();
  const r = await confirmYesNo("save?", { stdin, stdout });
  assert.equal(r, false);
});

test("confirmYesNo: 'y' resolves true, Enter defaults false", async () => {
  const stdinA = fakeStdin();
  const a = confirmYesNo("save?", { stdin: stdinA, stdout: fakeStdout() });
  stdinA.write("y");
  assert.equal(await a, true);

  const stdinB = fakeStdin();
  const b = confirmYesNo("save?", { stdin: stdinB, stdout: fakeStdout() });
  stdinB.write("\r");
  assert.equal(await b, false);
});

// ── pressAnyKeyToExit ────────────────────────────────────────────────────────

test("pressAnyKeyToExit: non-TTY resolves immediately without prompting", async () => {
  const stdin = new PassThrough(); // isTTY undefined → falsy
  const stdout = fakeStdout();
  await pressAnyKeyToExit({ stdin, stdout }); // resolves; test would hang if it blocked
  assert.equal(stdout._buf.out, "");
});

test("pressAnyKeyToExit: resolves on timeout even with no keypress (unattended backstop)", async () => {
  const stdin = fakeStdin();
  let paused = false;
  const origPause = stdin.pause.bind(stdin);
  stdin.pause = () => { paused = true; return origPause(); };
  // No key is ever written; the test would hang if the timeout didn't resolve.
  await pressAnyKeyToExit({ stdin, stdout: fakeStdout(), timeoutMs: 20 });
  assert.equal(paused, true); // terminal restored via the same cleanup path
  assert.equal(stdin.listenerCount("data"), 0);
});

test("pressAnyKeyToExit: any key resolves and pauses stdin so the loop can exit", async () => {
  const stdin = fakeStdin();
  let paused = false;
  const origPause = stdin.pause.bind(stdin);
  stdin.pause = () => { paused = true; return origPause(); };
  const stdout = fakeStdout();
  const p = pressAnyKeyToExit({ stdin, stdout });
  stdin.write("x");
  await p;
  assert.match(stdout._buf.out, /stays open in your browser/);
  assert.equal(paused, true);
  assert.equal(stdin.listenerCount("data"), 0); // listener removed
});

test("pressAnyKeyToExit: ignores early buffered input until the minimum hold elapses", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const p = pressAnyKeyToExit({ stdin, stdout, minHoldMs: 20, timeoutMs: 200 });
  stdin.write("x");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stdin.listenerCount("data"), 1);
  stdin.write("y");
  await new Promise((resolve) => setTimeout(resolve, 25));
  stdin.write("z");
  await p;
  assert.equal(stdin.listenerCount("data"), 0);
});

// ── promptChoice ─────────────────────────────────────────────────────────────

test("promptChoice: non-TTY quits with no selection", async () => {
  const stdin = new PassThrough(); // isTTY undefined → falsy
  const r = await promptChoice({ title: "t", options: ["a", "b"], stdin, stdout: fakeStdout() });
  assert.equal(r.quit, true);
  assert.equal(r.index, -1);
});

test("promptChoice: empty options quits safely", async () => {
  const stdin = fakeStdin();
  const r = await promptChoice({ title: "t", options: [], stdin, stdout: fakeStdout() });
  assert.equal(r.quit, true);
  assert.equal(r.index, -1);
});

test("promptChoice: digit key selects that option immediately", async () => {
  const stdin = fakeStdin();
  const p = promptChoice({ title: "t", options: ["first", "second", "third"], stdin, stdout: fakeStdout() });
  stdin.write("2");
  const r = await p;
  assert.equal(r.quit, false);
  assert.equal(r.index, 1);
});

test("promptChoice: Enter selects the highlighted (default first) option", async () => {
  const stdin = fakeStdin();
  const p = promptChoice({ title: "t", options: ["first", "second"], stdin, stdout: fakeStdout() });
  stdin.write("\r");
  const r = await p;
  assert.equal(r.quit, false);
  assert.equal(r.index, 0);
});

test("promptChoice: arrow down then Enter selects the second option", async () => {
  const stdin = fakeStdin();
  const p = promptChoice({ title: "t", options: ["first", "second"], stdin, stdout: fakeStdout() });
  stdin.write("\x1b[B"); // down
  stdin.write("\r");
  const r = await p;
  assert.equal(r.quit, false);
  assert.equal(r.index, 1);
});

test("promptChoice: 'q' quits without selecting", async () => {
  const stdin = fakeStdin();
  const p = promptChoice({ title: "t", options: ["first", "second"], stdin, stdout: fakeStdout() });
  stdin.write("q");
  const r = await p;
  assert.equal(r.quit, true);
  assert.equal(r.index, -1);
});

test("promptChoice: Esc quits without selecting", async () => {
  const stdin = fakeStdin();
  const p = promptChoice({ title: "t", options: ["first", "second"], stdin, stdout: fakeStdout() });
  stdin.write("\x1b");
  const r = await p;
  assert.equal(r.quit, true);
  assert.equal(r.index, -1);
});

test("promptChoice: out-of-range digit is ignored, Enter still selects focus", async () => {
  const stdin = fakeStdin();
  const p = promptChoice({ title: "t", options: ["only"], stdin, stdout: fakeStdout() });
  stdin.write("5"); // only 1 option — invalid jump
  stdin.write("\r");
  const r = await p;
  assert.equal(r.quit, false);
  assert.equal(r.index, 0);
});
