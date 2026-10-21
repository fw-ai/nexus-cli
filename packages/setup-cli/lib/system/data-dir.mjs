import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

export const DATA_DIRNAME = ".nexus";
export const LEGACY_DATA_DIRNAME = ".fireconnect";
/** Where an old `~/.fireconnect` is kept when this CLI's `~/.nexus` already exists. */
export const LEGACY_ASIDE_DIRNAME = ".nexus-pre";

/**
 * @param {string} file
 * @returns {import("node:fs").Stats | null}
 */
function lstatOrNull(file) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {import("node:fs").Stats | null}
 */
function statOrNull(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

/**
 * True when `dir` is this CLI's data directory (or empty), false when it holds
 * another program's files. Nexus is recognized by files only it writes.
 * @param {string} dir
 */
export function isNexusDataDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0 || entries.includes("key-storage.json") || entries.includes(RENAME_COMPLETE_MARKER)) {
    return true;
  }
  if (existsSync(path.join(dir, "cli", "packages", "setup-cli", "bin", "nexus.mjs"))) {
    return true;
  }
  try {
    const config = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
    return Boolean(config && typeof config === "object" && typeof config.harnesses === "object");
  } catch {
    return false;
  }
}

/**
 * Point `~/.fireconnect` at `~/.nexus` so anything still holding the old path
 * (a pre-rename launcher or upgrader, an open harness session, a downgrade)
 * reads and writes the same data.
 * @param {string} legacy
 * @param {NodeJS.Platform} platform
 */
function linkLegacyToTarget(legacy, platform) {
  try {
    if (platform === "win32") {
      symlinkSync(path.join(path.dirname(legacy), DATA_DIRNAME), legacy, "junction");
    } else {
      symlinkSync(DATA_DIRNAME, legacy, "dir");
    }
  } catch {
    // Already linked (a concurrent run) or not permitted; the data move stands.
  }
}

/**
 * True when `link` is a symlink (or junction) whose own target is `dest`,
 * as opposed to merely resolving to the same place through other links.
 * @param {string} link
 * @param {string} dest
 */
function linksTo(link, dest) {
  try {
    return lstatSync(link).isSymbolicLink()
      && path.resolve(path.dirname(link), readlinkSync(link)) === path.resolve(dest);
  } catch {
    return false;
  }
}

/**
 * True once the data lives in `~/.nexus` and `~/.fireconnect` is gone or links
 * to it, whichever process did the move.
 * @param {string} legacy
 * @param {string} target
 */
function alreadyMoved(legacy, target) {
  if (!statOrNull(target)?.isDirectory() || linksTo(target, legacy)) {
    return false;
  }
  return !lstatOrNull(legacy) || linksTo(legacy, target);
}

/**
 * Move each top-level entry `~/.nexus` lacks out of the old directory: the
 * install checkout the launchers run, harness backups `off` restores from, the
 * stored key. Entries both have keep `~/.nexus`'s copy.
 * @param {string} legacy
 * @param {string} target
 */
function moveMissingEntries(legacy, target) {
  let entries;
  try {
    entries = readdirSync(legacy);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (lstatOrNull(path.join(target, entry))) {
      continue;
    }
    try {
      renameSync(path.join(legacy, entry), path.join(target, entry));
    } catch {
      // Stays in the set-aside copy.
    }
  }
}

/**
 * Move the pre-rename `~/.fireconnect` data directory (or a dotfile manager's
 * link to one) to `~/.nexus`, leaving `~/.fireconnect` as a link to it.
 *
 * - `~/.nexus` already ours: what it lacks moves over and it keeps its own
 *   copy of the rest. Whatever is left of the old one is kept as `~/.nexus-pre`.
 * - `~/.nexus` belongs to another program: nothing is touched ("foreign").
 * - On Windows a running harness can hold files open, so the rename may fail;
 *   `~/.nexus` then links to the old directory until a later run finishes.
 *
 * Idempotent, safe to race with itself, and never throws.
 *
 * @param {string} home
 * @param {{ platform?: NodeJS.Platform, rename?: typeof renameSync }} [options]
 * @returns {"none" | "moved" | "set-aside" | "foreign" | "deferred" | "failed"}
 */
export function migrateLegacyDataDir(home, { platform = process.platform, rename = renameSync } = {}) {
  if (!home) {
    return "none";
  }
  const legacy = path.join(home, LEGACY_DATA_DIRNAME);
  const target = path.join(home, DATA_DIRNAME);
  if (!statOrNull(legacy)?.isDirectory()) {
    return "none";
  }
  if (linksTo(legacy, target)) {
    return "none";
  }
  const targetStat = lstatOrNull(target);
  if (linksTo(target, legacy)) {
    // A deferred move: retry it.
    try {
      unlinkSync(target);
    } catch {
      if (linksTo(target, legacy)) {
        return "deferred";
      }
    }
  } else if (targetStat) {
    if (alreadyMoved(legacy, target)) {
      return "none";
    }
    if (!isNexusDataDir(target)) {
      return "foreign";
    }
    if (linksTo(legacy, target)) {
      return "none";
    }
    // A linked ~/.fireconnect (a dotfiles checkout) is set aside whole, so
    // nothing is moved out of the user's repository.
    if (!lstatOrNull(legacy)?.isSymbolicLink()) {
      moveMissingEntries(legacy, target);
      try {
        rmdirSync(legacy);
        linkLegacyToTarget(legacy, platform);
        return "moved";
      } catch {
        // Something in it clashes with ~/.nexus; set the rest aside.
      }
    }
    const aside = lstatOrNull(path.join(home, LEGACY_ASIDE_DIRNAME))
      ? path.join(home, `${LEGACY_ASIDE_DIRNAME}-${Date.now()}`)
      : path.join(home, LEGACY_ASIDE_DIRNAME);
    try {
      rename(legacy, aside);
    } catch {
      // Gone or already a link: another run is handling it.
      const now = lstatOrNull(legacy);
      return !now || now.isSymbolicLink() ? "none" : "failed";
    }
    if (linksTo(aside, target)) {
      // Another run set the old directory aside first; this one took its link.
      try {
        renameSync(aside, legacy);
      } catch {
        unlinkSync(aside);
      }
      return "none";
    }
    linkLegacyToTarget(legacy, platform);
    return "set-aside";
  }
  try {
    rename(legacy, target);
  } catch {
    if (alreadyMoved(legacy, target)) {
      linkLegacyToTarget(legacy, platform);
      return "none";
    }
    try {
      // Junctions need no privileges on Windows but require an absolute target.
      if (platform === "win32") {
        symlinkSync(legacy, target, "junction");
      } else {
        symlinkSync(LEGACY_DATA_DIRNAME, target, "dir");
      }
      return "deferred";
    } catch {
      return alreadyMoved(legacy, target) ? "none" : "failed";
    }
  }
  linkLegacyToTarget(legacy, platform);
  return "moved";
}

const RENAME_COMPLETE_MARKER = "rename-complete";

/**
 * True for a FireConnect user whose rename hasn't finished every step yet.
 * Cheap enough for every CLI start; fresh Nexus installs have no
 * `~/.fireconnect` and never qualify.
 * @param {string} home
 */
export function renameMigrationIncomplete(home) {
  return Boolean(home)
    && Boolean(lstatOrNull(path.join(home, LEGACY_DATA_DIRNAME)))
    && !existsSync(path.join(home, DATA_DIRNAME, RENAME_COMPLETE_MARKER));
}

/**
 * Record that every rename step succeeded, so startup stops retrying.
 * @param {string} home
 */
export function markRenameMigrationComplete(home) {
  try {
    if (statOrNull(path.join(home, DATA_DIRNAME))?.isDirectory()) {
      writeFileSync(path.join(home, DATA_DIRNAME, RENAME_COMPLETE_MARKER), `${new Date().toISOString()}\n`);
    }
  } catch {
    // Startup retries the rename and tries again.
  }
}

const shownNotes = new Set();

/**
 * Record a note the CLI entry point already printed, so finalize, which runs
 * in the same process, doesn't print it again.
 * @param {string} note
 */
export function markDataDirNoteShown(note) {
  if (note) {
    shownNotes.add(note);
  }
}

/**
 * @param {string} note
 * @returns {boolean}
 */
export function dataDirNoteShown(note) {
  return shownNotes.has(note);
}

/**
 * @param {ReturnType<typeof migrateLegacyDataDir>} status
 * @returns {string} empty when there is nothing to tell the user
 */
export function dataDirMigrationNote(status) {
  switch (status) {
    case "moved":
      return `Moved ~/${LEGACY_DATA_DIRNAME} to ~/${DATA_DIRNAME}.`;
    case "deferred":
      return `Couldn't move ~/${LEGACY_DATA_DIRNAME} yet because files in it are in use; ~/${DATA_DIRNAME} links to it for now. `
        + "The move finishes on the next `nexus` command.";
    case "set-aside":
      return `~/${DATA_DIRNAME} already existed. It took what it was missing from ~/${LEGACY_DATA_DIRNAME} `
        + `and kept its own copy of the rest; the old copies are in ~/${LEGACY_ASIDE_DIRNAME}.`;
    case "foreign":
      return `~/${DATA_DIRNAME} belongs to another program, so your FireConnect settings stay in ~/${LEGACY_DATA_DIRNAME}. `
        + `Rename or remove ~/${DATA_DIRNAME}, then upgrade again.`;
    case "failed":
      return `Couldn't move ~/${LEGACY_DATA_DIRNAME} to ~/${DATA_DIRNAME}. `
        + "Check the permissions on your home directory, then run any `nexus` command to retry.";
    case "none":
      return "";
    default: {
      /** @type {never} */
      const unreachable = status;
      return unreachable;
    }
  }
}

/**
 * Rewrite absolute `~/.fireconnect/` path segments (POSIX or Windows) to `~/.nexus/`.
 * @param {string} text
 */
export function retargetLegacyPath(text) {
  return text
    .replaceAll(`/${LEGACY_DATA_DIRNAME}/`, `/${DATA_DIRNAME}/`)
    .replaceAll(`\\${LEGACY_DATA_DIRNAME}\\`, `\\${DATA_DIRNAME}\\`);
}

/**
 * The `~/.nexus` form of a path under `~/.fireconnect`, once it exists there.
 * Holds during a deferred move too, where `~/.nexus` links to the old directory.
 * @param {string} file
 */
export function preferDataDirPath(file) {
  const candidate = retargetLegacyPath(file);
  return candidate !== file && existsSync(candidate) ? candidate : file;
}
