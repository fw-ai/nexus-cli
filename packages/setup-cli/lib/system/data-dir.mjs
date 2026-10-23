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

const RENAME_COMPLETE_MARKER = "rename-complete";
const RENAME_ANNOUNCED_MARKER = "rename-announced";

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
 * Top-level entries this CLI writes into `~/.nexus`. Writers such as the
 * catalog and price caches run before `migrateLegacyDataDir` (the rename is
 * retried on every CLI start), and helpers that never run the migration at
 * all — the Claude status line and its price-refresh runner, the Claude
 * Desktop shim daemon, the installer — write others, so any of these can be
 * the only thing in a fresh `~/.nexus` when the migration first looks at it.
 * They have to count as ownership here, or the migration judges the CLI's own
 * writes foreign and every later upgrade fails telling the user another
 * program owns the directory. Add an entry here whenever a new
 * writer targets `~/.nexus` by name. Account-suffixed `.secret-memory-*`
 * files are matched by prefix in `isNexusDataDir`.
 */
export const NEXUS_OWNED_FILENAMES = Object.freeze([
  "key-storage.json",
  "secret-backend.json",
  RENAME_COMPLETE_MARKER,
  RENAME_ANNOUNCED_MARKER,
  "catalog-cache.json",
  "list-price-cache.json",
  "codex-stock-models.json",
  "update-check.json",
  "update-check.lock",
  "release-notes.json",
  "minted-key.json",
  "demo.json",
  ".api-key",
  ".secret-memory",
  "cli",
  "claude-desktop",
  "statusline-refresh",
]);

/**
 * Owned names distinctive enough to claim the directory on their own.
 * The rest of {@link NEXUS_OWNED_FILENAMES} (`demo.json`, `cli`,
 * `update-check.json`, ...) are generic enough that another program could
 * use them too: they count only when nothing foreign-looking is beside
 * them, which still covers a fresh `~/.nexus` one of Nexus's own early
 * writers created before the migration ran.
 */
export const NEXUS_STRONG_FILENAMES = Object.freeze([
  "key-storage.json",
  "secret-backend.json",
  RENAME_COMPLETE_MARKER,
  RENAME_ANNOUNCED_MARKER,
  "minted-key.json",
  ".secret-memory",
]);

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
  const owned = (entry) => NEXUS_OWNED_FILENAMES.includes(entry) || entry.startsWith(".secret-memory-");
  const strong = (entry) => NEXUS_STRONG_FILENAMES.includes(entry) || entry.startsWith(".secret-memory-");
  if (entries.length === 0 || entries.some(strong)) {
    return true;
  }
  if (existsSync(path.join(dir, "cli", "packages", "setup-cli", "bin", "nexus.mjs"))) {
    return true;
  }
  try {
    const config = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
    if (config && typeof config === "object" && !Array.isArray(config)
      && config.harnesses && typeof config.harnesses === "object"
      && !Array.isArray(config.harnesses)) {
      return true;
    }
  } catch {
    // Not our config; fall through to the generic-names check.
  }
  // A Nexus-owned directory can also hold a `config.json` that no longer
  // parses to our shape (hand edit, corruption): the file name is ours,
  // so it does not poison the tier — but it never claims the directory
  // on its own either.
  return entries.some(owned)
    && entries.every((entry) => owned(entry) || entry === "config.json");
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

/**
 * True when the rename would report "foreign" — `~/.fireconnect` still holds
 * this CLI's data and `~/.nexus` holds another program's files — without
 * moving anything. Lets upgrade/finalize stop before they touch either
 * directory instead of discovering it after the new code is already on disk.
 * @param {string} home
 */
export function hasForeignDataDir(home) {
  if (!home) {
    return false;
  }
  const legacy = path.join(home, LEGACY_DATA_DIRNAME);
  const target = path.join(home, DATA_DIRNAME);
  if (!statOrNull(legacy)?.isDirectory() || linksTo(legacy, target)) {
    return false;
  }
  if (!lstatOrNull(target) || linksTo(target, legacy) || alreadyMoved(legacy, target)) {
    return false;
  }
  return !isNexusDataDir(target);
}
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

/** The key message of the rename headline. */
export const RENAME_KEY_MESSAGE = "FireConnect is now Nexus CLI.";

/**
 * Shown once per machine, ahead of the rename notes, on whichever path runs
 * the rename first.
 * @param {{ primary?: (text: string) => string, command?: (text: string) => string }} [style]
 *   `primary` paints the key message; `command` renders the command name.
 */
export function renameHeadline({ primary = (text) => text, command = (text) => `\`${text}\`` } = {}) {
  return `${primary(RENAME_KEY_MESSAGE)} Use ${command("nexus")} from now on.\n`
    + "Your harnesses, key, and settings carry over unchanged.\n"
    + `FireRouter is now Nexus Auto: use the ${command("auto")} model.`;
}

/**
 * True until the rename headline has been shown to a FireConnect user. Every
 * upgrade path reaches it: `finalize-install` after any released upgrader,
 * the installer, and the first command after an upgrader that skipped finalize.
 * @param {string} home
 * @param {{ legacyLauncher?: boolean }} [options] whether the `fireconnect` launcher is still installed
 */
export function renameAnnouncementDue(home, { legacyLauncher = false } = {}) {
  if (!home || !(legacyLauncher || renameMigrationIncomplete(home))) {
    return false;
  }
  return ![DATA_DIRNAME, LEGACY_DATA_DIRNAME]
    .some((dirname) => existsSync(path.join(home, dirname, RENAME_ANNOUNCED_MARKER)));
}

/**
 * @param {string} home
 */
export function markRenameAnnounced(home) {
  try {
    if (statOrNull(path.join(home, DATA_DIRNAME))?.isDirectory()) {
      writeFileSync(path.join(home, DATA_DIRNAME, RENAME_ANNOUNCED_MARKER), `${new Date().toISOString()}\n`);
    }
  } catch {
    // The headline shows again on the next command.
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
