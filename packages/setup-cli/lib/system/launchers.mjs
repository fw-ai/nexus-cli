import { existsSync, readFileSync } from "node:fs";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DATA_DIRNAME, retargetLegacyPath } from "./data-dir.mjs";

export const COMMAND = "nexus";
const LEGACY_COMMAND = "fireconnect";

const LAUNCHER_SUFFIXES = ["", ".cmd"];

/** Launchers this CLI wrote, current or pre-rename; foreign files never match. */
const OWNED_LAUNCHER = /packages[\\/]setup-cli[\\/]bin[\\/](?:nexus|fireconnect)\.mjs/;

/**
 * @param {string} home
 * @param {string} name
 */
function launcherPath(home, name) {
  return path.join(home, ".local/bin", name);
}

/**
 * @param {string} file
 * @returns {Promise<string | null>}
 */
/**
 * True when `file` exists (or is a link) and isn't one of our launchers.
 * @param {string} file
 */
async function isForeignFile(file) {
  try {
    await lstat(file);
  } catch {
    return false;
  }
  return !OWNED_LAUNCHER.test((await readIfPresent(file)) ?? "");
}

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Bring a pre-rename launcher up to date: entry `bin/nexus.mjs`, install under
 * `~/.nexus/cli` once that exists.
 * @param {string} home
 * @param {string} content
 */
function currentLauncher(home, content) {
  const renamed = content
    .replaceAll("bin/fireconnect.mjs", "bin/nexus.mjs")
    .replaceAll("bin\\fireconnect.mjs", "bin\\nexus.mjs")
    .replaceAll("FIRECONNECT_NODE_BIN", "NEXUS_NODE_BIN")
    .replaceAll("fireconnect: Node.js was not found", "nexus: Node.js was not found")
    .replaceAll("FireConnect installer", "Nexus installer");
  const installed = existsSync(path.join(home, DATA_DIRNAME, "cli", "packages", "setup-cli", "bin", "nexus.mjs"));
  return installed ? retargetLegacyPath(renamed) : renamed;
}

/**
 * Replace the pre-rename `fireconnect` launcher (and Windows `.cmd` shim) with
 * `nexus`. A `nexus` that belongs to another program is never touched: the
 * `fireconnect` command stays, and the user is told why.
 *
 * @param {string} home
 * @returns {Promise<string[]>} notes for the user
 */
export async function migrateLegacyLaunchers(home) {
  const notes = [];
  for (const suffix of LAUNCHER_SUFFIXES) {
    const legacyPath = launcherPath(home, `${LEGACY_COMMAND}${suffix}`);
    const legacy = await readIfPresent(legacyPath);
    if (legacy === null || !OWNED_LAUNCHER.test(legacy)) {
      continue;
    }
    const target = launcherPath(home, `${COMMAND}${suffix}`);
    if (await isForeignFile(target)) {
      if (suffix === "") {
        notes.push(`~/.local/bin/${COMMAND} belongs to another program, so the \`${LEGACY_COMMAND}\` command stays. `
          + `Rename or remove that file, then run any \`${LEGACY_COMMAND}\` command to switch to \`${COMMAND}\`.`);
      }
      continue;
    }
    if (!OWNED_LAUNCHER.test((await readIfPresent(target)) ?? "")) {
      await writeFile(target, currentLauncher(home, legacy), { mode: 0o755 });
    }
    await rm(legacyPath, { force: true });
    if (suffix === "") {
      notes.push(`Replaced the \`${LEGACY_COMMAND}\` command with \`${COMMAND}\`.`);
    }
  }
  return notes;
}

/**
 * True while our pre-rename `fireconnect` launcher is still installed, which
 * means the rename never finished (an upgrader that skips finalize, or an
 * interrupted upgrade). Synchronous and cheap: it runs on every CLI start.
 *
 * @param {string} home
 * @returns {boolean}
 */
export function hasOwnedLegacyLauncher(home) {
  if (!home) {
    return false;
  }
  return LAUNCHER_SUFFIXES.some((suffix) => {
    try {
      return OWNED_LAUNCHER.test(readFileSync(launcherPath(home, `${LEGACY_COMMAND}${suffix}`), "utf8"));
    } catch {
      return false;
    }
  });
}

/**
 * Launchers this CLI installed under either name, for uninstall. Foreign files
 * are excluded so uninstall never deletes another tool's command.
 *
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function ownedLaunchers(home) {
  const owned = [];
  for (const name of [COMMAND, LEGACY_COMMAND]) {
    for (const suffix of LAUNCHER_SUFFIXES) {
      const file = launcherPath(home, `${name}${suffix}`);
      const content = await readIfPresent(file);
      if (content !== null && OWNED_LAUNCHER.test(content)) {
        owned.push(file);
      }
    }
  }
  return owned;
}
