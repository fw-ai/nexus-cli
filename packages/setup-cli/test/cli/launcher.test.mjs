import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildActionChoices,
  buildLauncherChoices,
  harnessStatusText,
  runLauncherCommand,
} from "../../lib/cli/commands/launcher.mjs";
import { listHarnesses } from "../../lib/harness/registry.mjs";
import { createBaseContext } from "../../lib/cli/parse-args.mjs";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
}

class FakeOutput {
  isTTY = true;
  columns = 120;
  chunks = [];
  write(chunk) {
    this.chunks.push(chunk);
    return true;
  }
  text() {
    return this.chunks.join("");
  }
}

async function tempCtx() {
  const home = await mkdtemp(path.join(tmpdir(), "fireconnect-launcher-"));
  return { ...createBaseContext(), home };
}

/** Run the launcher with fake streams, feeding `keys` after each render. */
function drive(ctx, keys, overrides = {}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = runLauncherCommand(ctx, { input, output, ...overrides });
  // Feed keys one tick apart, and only while a prompt is actually listening —
  // the launcher awaits config reads before the first render, and chains
  // prompts, so a raw burst would be dropped by the EventEmitter.
  const feed = (index) => {
    if (index >= keys.length) {
      return;
    }
    setImmediate(() => {
      if (input.listenerCount("data") === 0) {
        feed(index);
        return;
      }
      input.emit("data", keys[index]);
      feed(index + 1);
    });
  };
  feed(0);
  return done.then(() => output);
}

describe("harnessStatusText", () => {
  it("distinguishes on, off, detected, and absent", () => {
    assert.match(harnessStatusText({ enabled: true }, false), /on/);
    assert.match(harnessStatusText({ enabled: false }, true), /^(?!.*detected).*off/);
    assert.match(harnessStatusText(undefined, true), /off · detected/);
    assert.match(harnessStatusText(undefined, false), /not detected/);
  });
});

describe("buildLauncherChoices", () => {
  it("lists every harness, then configure/key/help", () => {
    const adapters = listHarnesses();
    const choices = buildLauncherChoices(adapters, {}, []);
    assert.equal(choices.length, adapters.length + 3);
    assert.deepEqual(choices[0].value, { kind: "harness", id: adapters[0].id });
    assert.deepEqual(choices.slice(-3).map((choice) => choice.value.kind), ["configure", "key", "help"]);
    assert.doesNotMatch(choices.at(-3).name, /register harnesses|API keys/i);
    assert.match(choices.at(-3).name, /provider|BYOK/i);
  });
});

describe("buildActionChoices", () => {
  it("mirrors the direct-CLI route shapes", () => {
    const [claude] = listHarnesses();
    const values = buildActionChoices(claude, false).map((choice) => choice.value);
    assert.deepEqual(values, [
      { verb: "on", noun: "" },
      { verb: "off", noun: "" },
      { verb: "status", noun: "" },
      { verb: "usage", noun: "" },
      { verb: "live", noun: "" },
    ]);
  });
});

describe("runLauncherCommand", () => {
  it("falls back to help when not a TTY", async () => {
    const input = new FakeInput();
    input.isTTY = false;
    const output = new FakeOutput();
    // printHelp writes via console.log; the launcher must return without
    // rendering a prompt or hanging on the non-TTY stream.
    await runLauncherCommand(await tempCtx(), { input, output });
    assert.ok(!output.text().includes("Pick a harness"));
  });

  it("exits cleanly on Esc at the top level", async () => {
    const output = await drive(await tempCtx(), [ESC]);
    assert.ok(output.text().includes("Cancelled."));
  });

  it("dispatches the picked harness action and teaches the fast path", async () => {
    const routes = [];
    const output = await drive(
      await tempCtx(),
      [ENTER, DOWN, DOWN, ENTER], // first harness (claude) -> third action (status)
      { dispatchHarness: async (route) => { routes.push(route); } },
    );
    assert.deepEqual(routes, [{ harnessId: "claude", verb: "status", noun: "" }]);
    assert.ok(output.text().includes("skip the menu: nexus claude status"));
  });

  it("teaches the bare fast path for on", async () => {
    const routes = [];
    const output = await drive(
      await tempCtx(),
      [ENTER, ENTER], // claude -> on
      { dispatchHarness: async (route) => { routes.push(route); } },
    );
    assert.deepEqual(routes, [{ harnessId: "claude", verb: "on", noun: "" }]);
    assert.ok(output.text().includes("skip the menu: nexus claude\n"));
  });

  it("returns to the harness list when an action menu is cancelled", async () => {
    const routes = [];
    const output = await drive(
      await tempCtx(),
      [ENTER, ESC, ESC], // into claude, back out, exit
      { dispatchHarness: async (route) => { routes.push(route); } },
    );
    assert.deepEqual(routes, []);
    assert.ok(output.text().includes("Cancelled."));
  });

  it("routes key through its subcommand menu", async () => {
    const adapters = listHarnesses();
    const subcommands = [];
    const keysToKeyRow = Array.from({ length: adapters.length + 1 }, () => DOWN);
    const output = await drive(
      await tempCtx(),
      [...keysToKeyRow, ENTER, ENTER], // key row -> status (first)
      { runKey: async (subcommand) => {
        subcommands.push(subcommand);
        return subcommand === "status" ? "nexus status" : `nexus key ${subcommand}`;
      } },
    );
    assert.deepEqual(subcommands, ["status"]);
    assert.ok(output.text().includes("skip the menu:"));
    assert.ok(output.text().includes("nexus status"));
  });

  it("runs configure from the menu", async () => {
    const adapters = listHarnesses();
    let ran = 0;
    const keysToConfigureRow = Array.from({ length: adapters.length }, () => DOWN);
    const output = await drive(
      await tempCtx(),
      [...keysToConfigureRow, ENTER],
      { runConfigure: async () => { ran += 1; } },
    );
    assert.equal(ran, 1);
    assert.ok(output.text().includes("skip the menu: nexus configure"));
  });
});
