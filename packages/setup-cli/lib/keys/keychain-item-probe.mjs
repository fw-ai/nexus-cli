import { spawn } from "node:child_process";

/** Exit status `security find-generic-password` uses for "no such item". */
const ITEM_NOT_FOUND = 44;

/**
 * Whether the macOS keychain holds a generic-password item, found by its
 * attributes alone. Reading the item's data is what shows the "node wants to
 * access key … in your keychain" prompt (once per process until the user picks
 * Always Allow); an attribute lookup leaves the data encrypted and never
 * prompts. So commands that only need to know a key is stored use this
 * instead of reading it.
 *
 * Bounded by a short timeout so a wedged keychain can't hang a status call.
 * @param {string} service
 * @param {string} account
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<boolean | null>} null when the lookup couldn't answer
 *   (no `security` tool, a timeout, a locked keychain): callers then read.
 */
export function macKeychainItemExists(service, account, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account], {
        stdio: "ignore",
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? true : code === ITEM_NOT_FOUND ? false : null);
    });
  });
}
