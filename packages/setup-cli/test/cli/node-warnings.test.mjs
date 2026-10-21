import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFireconnect, itIfSqlite } from "../helpers.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const BIN_PATH = path.join(here, "../../bin/nexus.mjs");

describe("node warning filter", () => {
  // `node:sqlite` (Cursor/VS Code state.vscdb access) emits an
  // ExperimentalWarning on import under Node >= 22. The installed launcher
  // passes --disable-warning, but a direct `node bin/nexus.mjs` (dev
  // alias) does not — and the warning used to land in the middle of
  // interactive output like the uninstall checklist.

  itIfSqlite("does not leak the node:sqlite ExperimentalWarning", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-warn-"));
    // Seed a real state.vscdb so the node:sqlite path is actually taken.
    const dbDir = path.join(home, "Library/Application Support/Cursor/User/globalStorage");
    await mkdir(dbDir, { recursive: true });
    const seeded = spawnSync("sqlite3", [
      path.join(dbDir, "state.vscdb"),
      "CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB); INSERT INTO ItemTable VALUES('x','y');",
    ], { encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);

    const result = await runFireconnect(["cursor", "status"], { HOME: home });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(combined, /ExperimentalWarning/,
      "no ExperimentalWarning should reach the user");
    assert.doesNotMatch(combined, /SQLite is an experimental feature/,
      "the node:sqlite warning must be filtered");
  });

  it("removes Node's default warning listener before installing the filter", async () => {
    // Node's default warning printer is itself a 'warning' listener, and
    // adding one does not replace it — so the filter only works if the
    // existing listeners are dropped first. Guard that ordering.
    const source = await readFile(BIN_PATH, "utf8");
    const removeIdx = source.indexOf('removeAllListeners("warning")');
    const onIdx = source.indexOf('process.on("warning"');
    assert.notEqual(removeIdx, -1, "must call process.removeAllListeners(\"warning\")");
    assert.notEqual(onIdx, -1, "must install a 'warning' listener");
    assert.ok(removeIdx < onIdx, "removeAllListeners must come before process.on");
  });

  it("still surfaces warnings that are not the sqlite one", () => {
    // The filter re-prints everything it does not suppress; a blanket
    // swallow would hide real deprecation/experimental warnings.
    const script = [
      'process.removeAllListeners("warning");',
      'process.on("warning", (w) => {',
      '  if (w.name === "ExperimentalWarning" && /\\bSQLite\\b/i.test(w.message)) return;',
      '  process.stderr.write(`(node:${process.pid}) ${w.name}: ${w.message}\\n`);',
      '});',
      'process.emitWarning("kept", "CustomWarning");',
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.match(result.stderr, /CustomWarning: kept/);
    // Exactly once — not duplicated by a leftover default listener.
    assert.equal(result.stderr.match(/CustomWarning: kept/g).length, 1);
  });
});
