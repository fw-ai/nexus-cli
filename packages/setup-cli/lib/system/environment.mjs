import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { readLocalVersion } from "./version.mjs";
import { shouldPreferFileBackendOnLinux, remoteSecretStorageDetail } from "../config/secret-storage-policy.mjs";

/**
 * Detect the host environment (OS, distro/WSL, Node, shell, secret-storage
 * backend) in a cross-platform way. Used by `nexus status` for live
 * machine diagnostics. Every probe is best-effort and never throws, so a weird
 * host degrades to partial info instead of failing.
 */

export const ENVIRONMENT_SCHEMA_VERSION = 1;

/**
 * @param {string} [home]
 * @returns {string}
 */
function resolveHome(home = "") {
  return home || process.env.HOME || os.homedir() || "";
}

/**
 * Run `fn`, returning `fallback` on any throw. Keeps detection total.
 * @template T @param {() => T} fn @param {T} fallback @returns {T}
 */
function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * @param {string} cmd @param {string[]} args
 * @returns {boolean} whether the binary exists (spawn didn't ENOENT).
 */
function binaryAvailable(cmd, args) {
  return safe(() => !spawnSync(cmd, args, { stdio: "ignore" }).error, false);
}

/**
 * Parse Linux distro identity from `/etc/os-release` (freedesktop standard).
 * @returns {{ id: string, versionId: string, prettyName: string } | null}
 */
function readLinuxDistro() {
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    const parsed = safe(() => {
      if (!existsSync(file)) {
        return null;
      }
      /** @type {Record<string, string>} */
      const map = {};
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match) {
          map[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
        }
      }
      return map;
    }, null);
    if (parsed) {
      return {
        id: parsed.ID ?? "",
        versionId: parsed.VERSION_ID ?? "",
        prettyName: parsed.PRETTY_NAME ?? "",
      };
    }
  }
  return null;
}

/** @returns {boolean} whether we're running under WSL (Windows Subsystem for Linux). */
export function isWsl() {
  if (process.platform !== "linux") {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }
  return safe(() => {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("microsoft") || version.includes("wsl");
  }, false);
}

/**
 * Which secret-storage backend Nexus will use here, and whether it's the
 * strong tier. `NEXUS_KEY_STORAGE=file` forces the encrypted-file backend;
 * macOS/Windows always have a native store; Linux needs a Secret Service
 * (probed via `secret-tool`), else it falls back to the encrypted file.
 * @returns {{ backend: string, strong: boolean, detail?: string }}
 */
export function detectSecretStorage() {
  if (process.env.NEXUS_KEY_STORAGE === "file") {
    return { backend: "file", strong: true, detail: "forced via NEXUS_KEY_STORAGE=file" };
  }
  const platform = process.platform;
  if (platform === "darwin") {
    return { backend: "macos-keychain", strong: true };
  }
  if (platform === "win32") {
    return { backend: "windows-credential-manager", strong: true };
  }
  if (shouldPreferFileBackendOnLinux()) {
    return {
      backend: "file",
      strong: true,
      detail: remoteSecretStorageDetail(),
    };
  }
  if (binaryAvailable("secret-tool", ["--version"])) {
    return { backend: "secret-service", strong: true };
  }
  return {
    backend: "file",
    strong: true,
    detail: "no Secret Service (libsecret) detected; using the encrypted-file fallback",
  };
}

/**
 * @param {"darwin"|"win32"|"linux"|string} platform
 * @param {boolean} wsl
 * @returns {"macos"|"windows"|"wsl"|"linux"|"unknown"}
 */
function environmentKind(platform, wsl) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (wsl) return "wsl";
  if (platform === "linux") return "linux";
  return "unknown";
}

/**
 * Detect the current environment. Pure (no writes); safe on any platform.
 * @param {{ home?: string }} [opts]
 * @returns {object}
 */
export function detectEnvironment({ home = "" } = {}) {
  const resolvedHome = resolveHome(home);
  const platform = process.platform;
  const wsl = isWsl();
  const installDir = path.join(resolvedHome, ".nexus", "cli");

  return {
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    detectedAt: new Date().toISOString(),
    cliVersion: safe(() => readLocalVersion(), "") || "",
    kind: environmentKind(platform, wsl),
    os: {
      platform,
      arch: process.arch,
      type: safe(() => os.type(), ""),
      release: safe(() => os.release(), ""),
      version: safe(() => (typeof os.version === "function" ? os.version() : ""), ""),
      wsl,
      distro: platform === "linux" ? readLinuxDistro() : null,
    },
    node: {
      version: process.versions.node,
      execPath: process.execPath,
    },
    shell: process.env.SHELL || process.env.ComSpec || "",
    secretStorage: detectSecretStorage(),
    fireconnect: {
      home: resolvedHome,
      dir: path.join(resolvedHome, ".nexus"),
      installDir: existsSync(installDir) ? installDir : null,
      isGitInstall: existsSync(path.join(installDir, ".git")),
    },
  };
}
