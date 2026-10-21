import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { keyExportCommand } from "../cli/path.mjs";
import { readGlobalConfig } from "../config/global-config.mjs";
import { shouldInstallShellEnvHook } from "../keys/api-key.mjs";
import { needsFireworksShellExport } from "./shell-fireworks-consumers.mjs";

export const SHELL_HOOK_BEGIN = "# >>> nexus >>>";
export const SHELL_HOOK_END = "# <<< nexus <<<";
const LEGACY_SHELL_HOOK_BEGIN = "# >>> fireconnect >>>";
const LEGACY_SHELL_HOOK_END = "# <<< fireconnect <<<";
const SHELL_HOOK_MARKERS = [
  [SHELL_HOOK_BEGIN, SHELL_HOOK_END],
  [LEGACY_SHELL_HOOK_BEGIN, LEGACY_SHELL_HOOK_END],
];

/**
 * @param {string} [home]
 */
export function resolveShellConfigPath(home = process.env.HOME ?? "") {
  if (!home) {
    throw new Error("HOME is required to resolve shell config path");
  }
  if (process.env.ZSH_VERSION || (process.env.SHELL ?? "").includes("zsh")) {
    return path.join(home, ".zshrc");
  }
  if (process.env.BASH_VERSION || (process.env.SHELL ?? "").includes("bash")) {
    if (process.platform === "darwin") {
      return path.join(home, ".bash_profile");
    }
    return path.join(home, ".bashrc");
  }
  return path.join(home, ".zshrc");
}

/**
 * @param {string} home
 */
export function shellHookBlock(home) {
  const exportCmd = keyExportCommand(home);
  // Capture the key from `nexus key export`. If the command fails or
  // returns nothing (e.g. node not on PATH in a non-interactive sandbox, or no
  // key stored), print a one-time hint to stderr — but only in interactive
  // shells (`[ -t 2 ]`) so CI and other non-interactive contexts stay quiet.
  // `2>/dev/null` keeps normal "no key yet" noise out of the way.
  return [
    SHELL_HOOK_BEGIN,
    `export FIREWORKS_API_KEY="$(${exportCmd} 2>/dev/null)"`,
    `if [ -z "\${FIREWORKS_API_KEY:-}" ] && [ -t 2 ]; then`,
    `  echo 'nexus: FIREWORKS_API_KEY is empty — run \`nexus status\` to check your key storage.' >&2`,
    "fi",
    SHELL_HOOK_END,
    "",
  ].join("\n");
}

/**
 * @param {string} raw
 */
export function stripShellHookBlock(raw) {
  return SHELL_HOOK_MARKERS.reduce((next, [begin, end]) => stripMarkedBlock(next, begin, end), raw);
}

/**
 * @param {string} raw
 * @param {string} beginMarker
 * @param {string} endMarker
 */
function stripMarkedBlock(raw, beginMarker, endMarker) {
  const lines = raw.split("\n");
  const isMarker = (line, marker) => line.replace(/\r$/, "").trim() === marker;
  const kept = [];
  let removed = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isMarker(lines[i], beginMarker)) {
      kept.push(lines[i]);
      continue;
    }
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isMarker(lines[j], beginMarker)) {
        break;
      }
      if (isMarker(lines[j], endMarker)) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      // Unpaired marker: keep it and everything after it rather than guess.
      kept.push(lines[i]);
      continue;
    }
    // Drop the blank line the block was separated by, so removal doesn't leave a gap.
    const after = lines[end + 1];
    if (kept.length > 0 && kept[kept.length - 1].replace(/\r$/, "") === "" && (after === undefined || after.replace(/\r$/, "") === "")) {
      kept.pop();
    }
    removed = true;
    i = end;
  }
  if (!removed) {
    return raw;
  }
  const next = kept.join("\n");
  return raw.endsWith("\n") && !next.endsWith("\n") ? `${next}\n` : next;
}

/**
 * Strip pre-rename hook blocks from every shell config, not just the current
 * shell's: they call the removed `fireconnect` launcher. Reconcile then writes
 * a `nexus` block where one is still needed.
 * @param {string} home
 * @returns {Promise<boolean>} true when any file changed
 */
export async function removeLegacyShellHooks(home) {
  let changed = false;
  for (const name of [".zshrc", ".bashrc", ".bash_profile"]) {
    const filePath = path.join(home, name);
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const next = stripMarkedBlock(raw, LEGACY_SHELL_HOOK_BEGIN, LEGACY_SHELL_HOOK_END);
    if (next !== raw) {
      await writeFile(filePath, next, "utf8");
      changed = true;
    }
  }
  return changed;
}

/**
 * @param {string} home
 */
export async function readShellConfig(home) {
  const filePath = resolveShellConfigPath(home);
  try {
    return { filePath, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { filePath, raw: "" };
    }
    throw error;
  }
}

/**
 * @param {string} home
 */
export async function installShellEnvHook(home) {
  const { filePath, raw } = await readShellConfig(home);
  const block = shellHookBlock(home);
  const without = stripShellHookBlock(raw);
  const separator = without && !without.endsWith("\n") ? "\n" : "";
  const next = `${without}${separator}${without ? "\n" : ""}${block}`;
  await writeFile(filePath, next, "utf8");
  return filePath;
}

/**
 * @param {string} home
 */
export async function removeShellEnvHook(home) {
  const { filePath, raw } = await readShellConfig(home);
  if (!SHELL_HOOK_MARKERS.some(([begin]) => raw.includes(begin))) {
    return false;
  }
  const next = stripShellHookBlock(raw);
  if (next.trim()) {
    await writeFile(filePath, next, "utf8");
  } else {
    await writeFile(filePath, "", "utf8");
  }
  return true;
}

/**
 * Reconcile the singleton shell block from all managed consumers.
 * @param {string} home
 */
export async function reconcileShellEnvHook(home) {
  const config = await readGlobalConfig(home);
  // Harness configs bake literals, provider keys included; only a legacy
  // env-ref harness config still needs FIREWORKS_API_KEY in the shell.
  const includeFireworks = await needsFireworksShellExport(
    home,
    config.harnesses,
    shouldInstallShellEnvHook(config.apiKey),
  );
  if (!includeFireworks) {
    await removeShellEnvHook(home);
    return null;
  }
  return installShellEnvHook(home);
}
