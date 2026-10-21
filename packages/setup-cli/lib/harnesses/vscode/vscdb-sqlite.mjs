import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/* -------------------------------------------------------------------------- */
/* Generic VS Code / Cursor `state.vscdb` ItemTable access.                    */
/*                                                                            */
/* Both VS Code and Cursor (a VS Code fork) persist app state in an SQLite     */
/* `state.vscdb` whose `ItemTable(key TEXT, value BLOB)` is a key/value store.  */
/* These helpers are IDE-agnostic; the Cursor- and VS-Code-specific layers      */
/* build on top. Prefer node:sqlite (Node >= 22), fall back to the `sqlite3`    */
/* CLI so the harness works on Node 18 too. Both paths are zero-dependency.     */
/* -------------------------------------------------------------------------- */

let NodeSqlite = null;
let nodeSqliteChecked = false;

async function loadNodeSqlite() {
  if (nodeSqliteChecked) {
    return NodeSqlite;
  }
  nodeSqliteChecked = true;
  try {
    // `node:sqlite` emits an ExperimentalWarning on import. It is filtered by
    // the persistent handler installed in bin/nexus.mjs — suppressing it
    // around this import does not work, because `process.emitWarning` defers
    // to `process.nextTick`, so the warning fires after any local window here
    // would have closed.
    const mod = await import("node:sqlite");
    NodeSqlite = mod.DatabaseSync;
  } catch {
    NodeSqlite = null;
  }
  return NodeSqlite;
}

/** Escape a JS string into a SQL string literal body (single quotes doubled). */
function sqlStringLiteral(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * True for "no such table: ItemTable" errors. A missing ItemTable just means no
 * value has ever been written (e.g. a freshly installed profile that never
 * launched) and is treated as "absent". Every other error (corrupt DB,
 * permission denied, I/O failure) must propagate so callers don't silently
 * treat real failures as "absent" and overwrite the user's data.
 */
function isMissingTableError(error) {
  return /no such table/i.test(error?.message ?? "");
}

/**
 * Read a text value from ItemTable by key. Returns "" when the DB file, the
 * ItemTable, or the row is missing. Any other error (corrupt DB, permission
 * denied, I/O failure) propagates so callers don't silently overwrite the
 * user's data. Uses node:sqlite when available; otherwise shells out to
 * `sqlite3` (raw stdout, which round-trips JSON values verbatim).
 *
 * @param {string} dbPath
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function readItemTableValue(dbPath, key) {
  if (!dbPath || !existsSync(dbPath)) {
    return "";
  }

  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
      const v = row?.value;
      if (v == null) {
        return "";
      }
      return typeof v === "string" ? v : new TextDecoder().decode(v);
    } catch (error) {
      // A missing ItemTable means no value yet; propagate everything else
      // (corrupt DB, permission denied, ...) so it isn't silently treated as
      // "absent" and overwritten.
      if (isMissingTableError(error)) {
        return "";
      }
      throw error;
    } finally {
      db?.close();
    }
  }

  const result = spawnSync("sqlite3", [dbPath, `SELECT value FROM ItemTable WHERE key='${sqlStringLiteral(key)}';`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (isMissingTableError({ message: result.stderr })) {
      return "";
    }
    throw new Error(`sqlite3 exited ${result.status}: ${(result.stderr || "").trim()}`);
  }
  // Raw stdout is the value verbatim plus a trailing newline.
  return result.stdout.replace(/\n$/, "");
}

/**
 * Ensure the ItemTable exists in the DB (creating the DB file if needed). VS
 * Code/Cursor create it themselves on first launch; this lets the harness write
 * a secret into a freshly-installed (never-launched) profile too.
 * @param {string} dbPath
 * @returns {Promise<void>}
 */
export async function ensureItemTable(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const ddl = "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);";
  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(dbPath);
      db.exec(ddl);
    } finally {
      db?.close();
    }
    return;
  }
  const result = spawnSync("sqlite3", [dbPath], { input: ddl, encoding: "utf8" });
  if (result.error) {
    throw new Error(`sqlite3 failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${result.stderr.trim()}`);
  }
}

/**
 * Write (insert or replace) a text value into ItemTable by key.
 * @param {string} dbPath
 * @param {string} key
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function writeItemTableValue(dbPath, key, value) {
  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(dbPath);
      db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, value);
    } finally {
      db?.close();
    }
    return;
  }

  const sql = `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${sqlStringLiteral(key)}', '${sqlStringLiteral(value)}');`;
  const result = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
  if (result.error) {
    throw new Error(`sqlite3 failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${result.stderr.trim()}`);
  }
}

/**
 * Delete an ItemTable row by key (no-op if missing).
 * @param {string} dbPath
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteItemTableValue(dbPath, key) {
  if (!dbPath || !existsSync(dbPath)) {
    return;
  }
  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(dbPath);
      db.prepare("DELETE FROM ItemTable WHERE key = ?").run(key);
    } finally {
      db?.close();
    }
    return;
  }

  const result = spawnSync("sqlite3", [dbPath, `DELETE FROM ItemTable WHERE key='${sqlStringLiteral(key)}';`], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`sqlite3 failed: ${result.error.message}`);
  }
}

/**
 * Apply multiple ItemTable mutations (writes and/or deletes) as a single
 * atomic transaction so the DB can never be left half-applied if one write
 * fails partway through. Each entry is `{ op: "set" | "del", key, value? }`.
 *
 * @param {string} dbPath
 * @param {{ op: "set" | "del", key: string, value?: string }[]} mutations
 * @returns {Promise<void>}
 */
export async function applyItemTableWrites(dbPath, mutations) {
  if (mutations.length === 0) {
    return;
  }

  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(dbPath);
      const setStmt = db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)");
      const delStmt = db.prepare("DELETE FROM ItemTable WHERE key = ?");
      db.exec("BEGIN");
      try {
        for (const m of mutations) {
          if (m.op === "del") {
            delStmt.run(m.key);
          } else {
            setStmt.run(m.key, m.value ?? "");
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      db?.close();
    }
    return;
  }

  // sqlite3 CLI fallback: batch all statements in one invocation. sqlite3
  // wraps the whole input in an implicit transaction, so it's atomic too.
  const sql = mutations.map((m) =>
    m.op === "del"
      ? `DELETE FROM ItemTable WHERE key='${sqlStringLiteral(m.key)}';`
      : `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${sqlStringLiteral(m.key)}', '${sqlStringLiteral(m.value ?? "")}');`,
  ).join("\n");
  const result = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
  if (result.error) {
    throw new Error(`sqlite3 failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${result.stderr.trim()}`);
  }
}
