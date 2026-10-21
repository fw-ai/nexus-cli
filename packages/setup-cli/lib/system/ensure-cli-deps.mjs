import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to packages/setup-cli (where package.json and node_modules live).
 * @returns {string}
 */
export function resolveSetupCliDir() {
  // This module lives at lib/system/, so the package root (where package.json
  // and node_modules live) is two levels up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * @param {string} dep
 * @param {string} [setupDir]
 * @returns {boolean}
 */
export function dependencyInstalled(dep, setupDir = resolveSetupCliDir()) {
  return existsSync(path.join(setupDir, "node_modules", dep, "package.json"));
}

/**
 * @param {string} [setupDir]
 * @returns {boolean}
 */
export function crossKeychainInstalled(setupDir = resolveSetupCliDir()) {
  return dependencyInstalled("cross-keychain", setupDir);
}

/**
 * @param {string} [setupDir]
 * @returns {string[] | null}
 */
export function runtimeDependencyNames(setupDir = resolveSetupCliDir()) {
  const pkgPath = path.join(setupDir, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return Object.keys(pkg.dependencies ?? {});
  } catch {
    return null;
  }
}

/**
 * @param {string} [setupDir]
 * @returns {boolean}
 */
export function runtimeDepsInstalled(setupDir = resolveSetupCliDir()) {
  const dependencies = runtimeDependencyNames(setupDir);
  return dependencies !== null
    && dependencies.every((dep) => dependencyInstalled(dep, setupDir));
}

/**
 * @returns {string}
 */
export function cliDependenciesMissingMessage() {
  return "Nexus is missing required dependencies. Run `nexus update` to install them, or re-run the curl installer.";
}

/**
 * Install runtime dependencies when any are missing — e.g. after
 * `npm install -g ./packages/setup-cli` from a checkout without a prior
 * `npm install` in packages/setup-cli, or a broken partial install.
 *
 * @param {string} [setupDir]
 * @returns {boolean} true when all runtime deps are present after this call
 */
export function ensureCliDependencies(setupDir = resolveSetupCliDir()) {
  if (runtimeDepsInstalled(setupDir)) {
    return true;
  }
  if (!existsSync(path.join(setupDir, "package.json"))) {
    return false;
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    execFileSync(
      npm,
      ["install", "--omit=dev", "--no-fund", "--no-audit"],
      {
        cwd: setupDir,
        env: { ...process.env, NEXUS_SKIP_POSTINSTALL_FINALIZE: "1" },
        stdio: "pipe",
        encoding: "utf8",
      },
    );
  } catch {
    return false;
  }

  return runtimeDepsInstalled(setupDir);
}
