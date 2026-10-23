import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * An Electron app's user-data folder (Cursor, VS Code, …) for `home`:
 * - macOS: ~/Library/Application Support/<name>
 * - Windows: %APPDATA%\<name>, else ~/AppData/Roaming/<name>
 * - Linux and others: $XDG_CONFIG_HOME/<name>, else ~/.config/<name>
 * Shared by the harnesses that write into these folders and by install
 * detection, so both always look in the same place.
 *
 * @param {string} home
 * @param {string} name the app's folder name, e.g. "Cursor" or "Code"
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function appUserDataDir(home, name, { platform = os.platform(), env = process.env } = {}) {
  const baseHome = home || env.HOME || "";
  if (platform === "darwin") {
    return path.join(baseHome, "Library", "Application Support", name);
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(baseHome, "AppData", "Roaming"), name);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(baseHome, ".config"), name);
}
