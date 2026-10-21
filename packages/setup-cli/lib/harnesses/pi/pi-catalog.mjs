import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fullFireworksResourceId } from "../../fireworks/model-id.mjs";

const PI_SCOPES = ["@earendil-works", "@mariozechner"];

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** The pi-coding-agent package directory behind `pi` on PATH. */
function piPackageDir(env) {
  const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!existsSync(candidate)) continue;
      let current = path.dirname(realpathSync(candidate));
      for (let depth = 0; depth < 6; depth += 1) {
        const name = readJson(path.join(current, "package.json"))?.name;
        if (PI_SCOPES.some((scope) => name === `${scope}/pi-coding-agent`)) return current;
        current = path.dirname(current);
      }
    }
  }
  return null;
}

/** Fireworks ids in the catalog bundled with the installed pi-ai (nested or hoisted). */
function bundledIds(packageDir) {
  const roots = [path.join(packageDir, "node_modules"), path.dirname(path.dirname(packageDir))];
  for (const root of roots) {
    for (const scope of PI_SCOPES) {
      const dist = path.join(root, scope, "pi-ai", "dist");
      const data = readJson(path.join(dist, "providers", "data", "fireworks.json"));
      if (data) {
        return Object.values(data).flatMap((byId) => Object.keys(byId ?? {}))
          .map((key) => key.replace(/^chat:/, ""));
      }
      const generated = path.join(dist, "models.generated.js");
      if (existsSync(generated)) {
        return [...readFileSync(generated, "utf8").matchAll(/"(accounts\/fireworks\/[^"]+)"/g)]
          .map((match) => match[1]);
      }
    }
  }
  return null;
}

/**
 * Fireworks model ids the installed Pi already knows: its bundled catalog plus
 * the pi.dev overlay it caches in `models-store.json`. Null when the install
 * can't be read (or in tests), so callers fall back to rows only Nexus can
 * provide. Filesystem reads only.
 * @param {{ settingsPath: string, env?: NodeJS.ProcessEnv }} args
 * @returns {Set<string> | null}
 */
export function piKnownFireworksModelIds({ settingsPath, env = process.env }) {
  if (env.NEXUS_TEST) return null;
  try {
    const packageDir = piPackageDir(env);
    const bundled = packageDir ? bundledIds(packageDir) : null;
    if (!bundled) return null;
    const store = readJson(path.join(path.dirname(settingsPath), "models-store.json"));
    const overlay = (store?.fireworks?.models ?? []).map((model) => model?.id).filter(Boolean);
    return new Set([...bundled, ...overlay].map(fullFireworksResourceId));
  } catch {
    return null;
  }
}
