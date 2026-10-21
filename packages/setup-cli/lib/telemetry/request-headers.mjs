import { HARNESS } from "../harness/id.mjs";
import { readLocalVersion } from "../system/version.mjs";

export const FIRECONNECT_TELEMETRY_HEADER_NAMES = Object.freeze([
  "x-firerouter-harness",
  "x-title",
  "fireworks-use-case",
  "http-referer",
]);

const MANAGED_NAMES = new Set(FIRECONNECT_TELEMETRY_HEADER_NAMES);
const VERSION_PATTERN = /\bv?(\d+\.\d+\.\d+)\b/;
const HARNESS_TITLES = Object.freeze({
  [HARNESS.CLAUDE]: "Claude Code",
  [HARNESS.CLAUDE_DESKTOP]: "Claude Desktop",
  [HARNESS.OPENCODE]: "OpenCode",
  [HARNESS.CODEX]: "Codex",
  [HARNESS.PI]: "Pi",
  [HARNESS.VSCODE]: "VS Code Chat",
  [HARNESS.COPILOT_APP]: "GitHub Copilot",
  [HARNESS.COPILOT_CLI]: "GitHub Copilot CLI",
  [HARNESS.DEEPSEEK]: "DeepSeek Harness",
});

function normalizedVersion(value) {
  return String(value ?? "").match(VERSION_PATTERN)?.[1] ?? "";
}

export function buildFireconnectTelemetryHeaders(
  harnessId,
  { fireconnectVersion = readLocalVersion() } = {},
) {
  const harnessTitle = HARNESS_TITLES[harnessId];
  if (!harnessTitle) {
    throw new Error(`No request attribution title configured for harness: ${harnessId}`);
  }
  return {
    "X-Title": harnessTitle,
    "HTTP-Referer": telemetryReferer(fireconnectVersion),
  };
}

/**
 * The `HTTP-Referer` value that identifies this CLI's traffic to the gateway.
 * @param {string} [version]
 */
export function telemetryReferer(version = readLocalVersion()) {
  const safeVersion = normalizedVersion(version);
  return `nexus/${safeVersion ? `v${safeVersion}` : "unknown"}`;
}

const LEGACY_REFERER = /(?<![\w/.-])(?:fireconnect\/(?:unknown|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)|nexus\/unknown)(?![\w.-])/g;

/**
 * Replace pre-rename `fireconnect/v<version>` referer values baked into a
 * harness config with the current one. Format-agnostic: the value is unique
 * to this CLI wherever it appears (JSON, TOML, or header lines).
 * @param {string} text
 */
export function retargetLegacyReferer(text) {
  return text.replace(LEGACY_REFERER, telemetryReferer());
}

function isLegacyFireconnectUserAgent(name, value) {
  return name.toLowerCase() === "user-agent"
    && /^(?:fireconnect|nexus)\/(?:unknown|\d+\.\d+\.\d+)$/i.test(String(value).trim());
}

export function stripFireconnectTelemetryHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => !MANAGED_NAMES.has(name.toLowerCase())
        && !isLegacyFireconnectUserAgent(name, value),
    ),
  );
}

export function mergeFireconnectTelemetryHeaders(existing = {}, telemetry = {}) {
  return {
    ...stripFireconnectTelemetryHeaders(existing),
    ...telemetry,
  };
}

export function stripFireconnectTelemetryHeaderLines(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .split("\n")
    .filter((line) => {
      const colon = line.indexOf(":");
      const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
      const headerValue = colon === -1 ? "" : line.slice(colon + 1).trim();
      return line.trim()
        && !MANAGED_NAMES.has(name)
        && !isLegacyFireconnectUserAgent(name, headerValue);
    })
    .join("\n");
}

export function mergeFireconnectTelemetryHeaderLines(value, telemetry = {}) {
  const managed = Object.entries(telemetry)
    .map(([name, headerValue]) => `${name}: ${headerValue}`)
    .join("\n");
  return [managed, stripFireconnectTelemetryHeaderLines(value)]
    .filter(Boolean)
    .join("\n");
}
