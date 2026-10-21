import process from "node:process";

const LEGACY_PREFIX = "FIRECONNECT_";
const PREFIX = "NEXUS_";

/**
 * Honor pre-rename `FIRECONNECT_*` variables as their `NEXUS_*` names, which
 * win when both are set. Child processes inherit the result.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function adoptLegacyEnv(env = process.env) {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_PREFIX) || value === undefined) {
      continue;
    }
    const current = `${PREFIX}${name.slice(LEGACY_PREFIX.length)}`;
    if (env[current] === undefined) {
      env[current] = value;
    }
  }
}

adoptLegacyEnv();
