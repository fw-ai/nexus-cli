import { spawn } from "node:child_process";
import process from "node:process";

import { resolveCliPath } from "../cli/path.mjs";
import { warn as uiWarn } from "../ui.mjs";

/**
 * Best-effort self-check that the shell env hook will be able to load the
 * Fireworks API key at shell startup. It spawns `nexus key export` the
 * same way the hook does, but with `FIREWORKS_API_KEY` stripped from the child
 * environment so it exercises the secret-store (keychain / encrypted file) path
 * rather than a pre-existing env var.
 *
 * Non-fatal: returns a result object so callers can warn without aborting `on`.
 *
 * @param {string} home
 * @param {{ expectedKey?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function verifyKeyExportWorks(home, options = {}) {
  const cliPath = resolveCliPath(home);
  const timeoutMs = options.timeoutMs ?? 8000;

  /** @type {Record<string, string>} */
  const childEnv = { ...process.env };
  // Strip the env var so we test the secret-store path, not a pre-set env.
  delete childEnv.FIREWORKS_API_KEY;
  if (home) {
    childEnv.HOME = home;
  }

  return new Promise((resolve) => {
    /** @type {string[]} */
    const args = cliPath.endsWith(".mjs")
      ? [cliPath, "key", "export"]
      : ["key", "export"];
    const child = cliPath.endsWith(".mjs")
      ? spawn(process.execPath, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(cliPath, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `could not run \`${cliPath} key export\`: ${error.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, reason: `\`${cliPath} key export\` timed out after ${timeoutMs}ms` });
        return;
      }
      const key = stdout.trim();
      if (code !== 0) {
        const detail = stderr.trim() ? ` (${stderr.trim()})` : "";
        resolve({ ok: false, reason: `\`${cliPath} key export\` exited with code ${code}${detail}` });
        return;
      }
      if (!key) {
        resolve({ ok: false, reason: `\`${cliPath} key export\` returned an empty key` });
        return;
      }
      if (options.expectedKey && key !== options.expectedKey.trim()) {
        resolve({ ok: false, reason: `\`${cliPath} key export\` returned a different key than expected` });
        return;
      }
      resolve({ ok: true });
    });
  });
}

/**
 * Print a user-facing warning when the env-hook self-check fails. Never throws.
 *
 * @param {string} harnessId
 * @param {string} reason
 */
export function printKeySelfCheckWarning(harnessId, reason) {
  console.warn(uiWarn(
    `${harnessId} reads FIREWORKS_API_KEY from the environment via a shell hook, `
      + `but the key could not be loaded the way the hook loads it. ${reason}. `
      + `Run \`nexus status\` to verify your key is stored, and make sure `
      + `~/.local/bin/nexus runs in a fresh shell (it uses the Node path baked at install time).`,
  ));
}
