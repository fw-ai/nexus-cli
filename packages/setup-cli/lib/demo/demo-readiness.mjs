/**
 * Pre-flight readiness checks and interactive gate for `nexus claude demo`.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { claudePathsFor } from "../harness/context.mjs";
import { mappingFromSettings, providerStatusFromEnv } from "../harnesses/claude/core.mjs";
import { resolveFireworksApiKey } from "../keys/harness-api-key.mjs";
import { readJsonIfExists } from "../io/json.mjs";
import { resolveSetupCliDir } from "../system/ensure-cli-deps.mjs";
import {
  BOLD, DIM, PRIMARY, RED, RESET, YELLOW,
  CLEAR_SCREEN, HOME_CURSOR, CLEAR_LINE, HIDE_CURSOR, SHOW_CURSOR, moveTo,
} from "./ansi.mjs";
export const FIRECONNECT_REQUIRED_MSG =
  "Run `nexus claude` first (check with `nexus claude status`).";

export const DEMO_CANCELLED_MSG = "Demo cancelled.";

/**
 * @typedef {{
 *   ok: boolean,
 *   claudeOn: boolean,
 *   fireworksKey: boolean,
 *   claudeBinary: boolean,
 *   mapping: ReturnType<typeof mappingFromSettings>,
 * }} DemoReadiness
 */

/**
 * @param {{ home?: string, settingsPath?: string, apiKey?: string }} args
 * @returns {Promise<DemoReadiness>}
 */
export async function assessDemoReadiness({ home = "", settingsPath = "", apiKey = "" } = {}) {
  const resolvedHome = home || process.env.HOME || "";
  const { settingsPath: resolvedSettingsPath } = claudePathsFor({ home: resolvedHome, settingsPath });
  const settings = await readJsonIfExists(resolvedSettingsPath);
  const claudeOn = providerStatusFromEnv(settings?.env ?? {}) === "fireworks";
  const fwKey = await resolveFireworksApiKey({ apiKey, home: resolvedHome });
  const claudeBinary = commandOnPath("claude");
  return {
    ok: claudeOn && Boolean(fwKey) && claudeBinary,
    claudeOn,
    fireworksKey: Boolean(fwKey),
    claudeBinary,
    mapping: mappingFromSettings(settings ?? {}),
  };
}

function commandOnPath(name) {
  return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

function statusMark(ok) {
  return ok ? `${PRIMARY}✓${RESET}` : `${RED}✗${RESET}`;
}

function renderReadinessLines(readiness) {
  const lines = [
    "",
    `  ${BOLD}Nexus CLI Demo: get ready${RESET}`,
    `  ${DIM}Both sides use your Nexus CLI Claude setup. Anthropic slots run real Anthropic; only --model differs.${RESET}`,
    "",
    `  ${statusMark(readiness.claudeOn)}  ${BOLD}nexus claude${RESET}  ${DIM}(Fireworks routing)${RESET}`,
    `  ${statusMark(readiness.fireworksKey)}  ${BOLD}Fireworks API key${RESET}  ${DIM}(login or FIREWORKS_API_KEY)${RESET}`,
    `  ${statusMark(readiness.claudeBinary)}  ${BOLD}claude${RESET} on PATH  ${DIM}(Claude Code CLI)${RESET}`,
    "",
  ];
  if (readiness.ok) {
    lines.push(`  ${PRIMARY}Ready.${RESET} Press ${BOLD}Enter${RESET} to pick models and start.`);
  } else {
    lines.push(`  ${YELLOW}Fix the items above, then press ${BOLD}r${RESET} to refresh.${RESET}`);
    if (!readiness.claudeOn) {
      lines.push(`  ${DIM}Tip: press ${BOLD}o${RESET}${DIM} to run \`nexus claude\`${RESET}`);
    }
    if (!readiness.fireworksKey) {
      lines.push(`  ${DIM}Tip: run \`nexus login\` in another terminal${RESET}`);
    }
  }
  lines.push("");
  lines.push(`  ${DIM}Enter continue · r refresh · o claude on · q quit${RESET}`);
  return lines;
}

function runFireconnectClaudeOn(home) {
  const bin = path.join(resolveSetupCliDir(), "bin/nexus.mjs");
  spawnSync(process.execPath, [bin, "claude", "on"], {
    env: { ...process.env, HOME: home || process.env.HOME || "" },
    stdio: "inherit",
  });
}

/**
 * Block until demo prerequisites pass or the user quits.
 * @param {{ home?: string, settingsPath?: string, apiKey?: string, stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} args
 * @returns {Promise<DemoReadiness>}
 */
export async function runReadinessGate({
  home = "",
  settingsPath = "",
  apiKey = "",
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  let readiness = await assessDemoReadiness({ home, settingsPath, apiKey });

  if (readiness.ok || !stdin.isTTY) {
    if (!readiness.ok) {
      throw new Error(formatReadinessError(readiness));
    }
    return readiness;
  }

  let prevLineCount = 0;
  let firstDraw = true;
  const redraw = () => {
    const lines = renderReadinessLines(readiness);
    const n = Math.max(prevLineCount, lines.length);
    let out = firstDraw ? `${CLEAR_SCREEN}${HOME_CURSOR}` : HOME_CURSOR;
    firstDraw = false;
    for (let i = 0; i < n; i += 1) {
      out += `${moveTo(i + 1, 1)}${lines[i] ?? ""}${CLEAR_LINE}`;
    }
    stdout.write(out);
    prevLineCount = lines.length;
  };

  stdout.write(HIDE_CURSOR);
  redraw();

  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    let escTimer = null;
    let buf = "";

    const cleanup = () => {
      clearTimeout(escTimer);
      stdin.removeListener("data", onData);
      stdin.pause();
      if (typeof stdin.unref === "function") {
        stdin.unref();
      }
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdout.write(SHOW_CURSOR);
      stdout.write(`${HOME_CURSOR}${CLEAR_LINE}`);
    };

    const refresh = async () => {
      readiness = await assessDemoReadiness({ home, settingsPath, apiKey });
      redraw();
    };

    const onData = async (chunk) => {
      buf += chunk.toString("latin1");
      while (buf.length > 0) {
        const ch = buf[0];
        if (ch === "\x1b") {
          if (buf.length >= 3 && buf[1] === "[") {
            buf = buf.slice(3);
            continue;
          }
          if (buf.length >= 2 && buf[1] !== "[") {
            buf = buf.slice(1);
            cleanup();
            reject(new Error(DEMO_CANCELLED_MSG));
            return;
          }
          if (buf.length === 1) {
            clearTimeout(escTimer);
            escTimer = setTimeout(() => {
              if (buf === "\x1b") {
                buf = "";
                cleanup();
                reject(new Error(DEMO_CANCELLED_MSG));
              }
            }, 40);
            return;
          }
          return;
        }
        buf = buf.slice(1);
        if (ch === "\x03") {
          cleanup();
          reject(new Error(DEMO_CANCELLED_MSG));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          if (readiness.ok) {
            cleanup();
            resolve(readiness);
            return;
          }
          continue;
        }
        if (ch === "q" || ch === "Q") {
          cleanup();
          reject(new Error(DEMO_CANCELLED_MSG));
          return;
        }
        if (ch === "r" || ch === "R") {
          await refresh();
          continue;
        }
        if ((ch === "o" || ch === "O") && !readiness.claudeOn) {
          stdout.write(SHOW_CURSOR);
          runFireconnectClaudeOn(home);
          stdout.write(HIDE_CURSOR);
          await refresh();
          continue;
        }
      }
    };

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("latin1");
    stdin.on("data", onData);
  });
}

/** @param {DemoReadiness} readiness */
export function formatReadinessError(readiness) {
  const parts = [];
  if (!readiness.claudeOn) {
    parts.push(FIRECONNECT_REQUIRED_MSG);
  }
  if (!readiness.fireworksKey) {
    parts.push("No Fireworks API key found — run `nexus login`, export FIREWORKS_API_KEY, or pass --api-key.");
  }
  if (!readiness.claudeBinary) {
    parts.push("Claude Code CLI (`claude`) not found on PATH.");
  }
  return parts.join(" ");
}
