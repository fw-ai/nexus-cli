import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readJsonIfExists, writeJson } from "../io/json.mjs";
import { primary } from "../ui/style.mjs";

export const RELEASE_NOTES_STATE_RELATIVE_PATH = ".nexus/release-notes.json";

const LOCAL_RELEASE_NOTES_PATH = fileURLToPath(
  new URL("./release-notes.json", import.meta.url),
);

function versionParts(version) {
  return String(version ?? "")
    .replace(/^v/, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export async function readReleaseNotes(catalogPath = LOCAL_RELEASE_NOTES_PATH) {
  try {
    const parsed = JSON.parse(await readFile(catalogPath, "utf8"));
    return Array.isArray(parsed.releases)
      ? parsed.releases.filter((release) => (
        typeof release?.version === "string"
        && Array.isArray(release.highlights)
      ))
      : [];
  } catch {
    return [];
  }
}

export function releaseNotesForRange(releases, fromVersion, toVersion) {
  if (!toVersion) {
    return [];
  }
  if (!fromVersion) {
    return releases.filter((release) => release.version === toVersion);
  }
  return releases
    .filter((release) => (
      compareVersions(release.version, fromVersion) > 0
      && compareVersions(release.version, toVersion) <= 0
    ))
    .sort((left, right) => compareVersions(left.version, right.version));
}

/**
 * @param {{ version: string, highlights: string[], improvements?: string[], footer?: string, emphasis?: string }} release
 * @param {{ emphasize?: (text: string) => string }} [options]
 *   `emphasize` styles the release's `emphasis` text wherever it appears.
 */
export function formatReleaseNotes(release, { emphasize } = {}) {
  const emphasized = (item) => (
    emphasize && release.emphasis ? item.replaceAll(release.emphasis, emphasize(release.emphasis)) : item
  );
  const lines = [
    `What's new in Nexus CLI v${release.version}`,
    "",
    ...release.highlights.map((item) => `• ${emphasized(item)}`),
  ];
  if (release.improvements?.length) {
    lines.push("", "Also improved:");
    lines.push(...release.improvements.map((item) => `• ${item}`));
  }
  if (release.footer) {
    lines.push("", release.footer);
  }
  return lines.join("\n");
}

async function readReleaseNotesState(statePath) {
  try {
    return await readJsonIfExists(statePath);
  } catch {
    return {};
  }
}

async function printUnseenReleaseNotes({
  home,
  releases,
  output,
}) {
  if (!home || releases.length === 0) {
    return false;
  }
  const statePath = path.join(home, RELEASE_NOTES_STATE_RELATIVE_PATH);
  const state = await readReleaseNotesState(statePath);
  const latestVersion = releases.at(-1).version;
  if (
    typeof state.lastShownVersion === "string"
    && compareVersions(state.lastShownVersion, latestVersion) >= 0
  ) {
    return false;
  }

  const emphasize = (text) => primary(text, output);
  output.write(`\n${releases.map((release) => formatReleaseNotes(release, { emphasize })).join("\n\n")}\n\n`);
  await writeJson(statePath, {
    ...state,
    lastShownVersion: latestVersion,
  }, { mode: 0o600 });
  return true;
}

export async function printReleaseNotesAfterUpgrade({
  home,
  fromVersion,
  toVersion,
  installDir,
  output = process.stderr,
}) {
  try {
    const catalogPath = installDir
      ? path.join(
        installDir,
        "packages/setup-cli/lib/system/release-notes.json",
      )
      : LOCAL_RELEASE_NOTES_PATH;
    const releases = releaseNotesForRange(
      await readReleaseNotes(catalogPath),
      fromVersion,
      toVersion,
    );
    return await printUnseenReleaseNotes({ home, releases, output });
  } catch {
    return false;
  }
}
