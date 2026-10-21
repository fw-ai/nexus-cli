/** @typedef {"" | "claude" | "claude-desktop" | "opencode" | "codex" | "pi" | "cursor" | "vscode" | "copilot-app" | "copilot-cli" | "deepseek"} HarnessArg */

export const HARNESS = Object.freeze({
  CLAUDE: "claude",
  // The Claude Desktop app: routes its native api.anthropic.com inference
  // through a local Fireworks proxy while leaving claude.ai connectors native.
  CLAUDE_DESKTOP: "claude-desktop",
  OPENCODE: "opencode",
  CODEX: "codex",
  PI: "pi",
  CURSOR: "cursor",
  VSCODE: "vscode",
  // GitHub ships two products both branded "GitHub Copilot", with no shared
  // config: the desktop app keeps BYOK providers in ~/.copilot/data.db, the
  // CLI in ~/.copilot/providers.json. Neither reads the other's. They are
  // named explicitly because a bare `copilot` is genuinely ambiguous — it is
  // also the CLI's own binary name.
  COPILOT_APP: "copilot-app",
  COPILOT_CLI: "copilot-cli",
  DEEPSEEK: "deepseek",
});

export const HARNESSES = Object.freeze(Object.values(HARNESS));

/**
 * Harness name aliases → canonical harness id. The ChatGPT app shares
 * ~/.codex/config.toml + the fireworks-model-catalog.json with the Codex CLI, so
 * `chatgpt` is not a separate harness — it routes to `codex`. Kept here, next to
 * the canonical harness names, so the parser and help text share one source of
 * truth.
 */
export const HARNESS_ALIASES = Object.freeze({
  chatgpt: HARNESS.CODEX,
});

/**
 * Every command that connects a harness, in help order. `featured` rows are the
 * ones `login` suggests next; `nexus harnesses` lists them all.
 * @type {ReadonlyArray<Readonly<{ command: string, name: string, featured?: boolean }>>}
 */
export const HARNESS_COMMANDS = Object.freeze([
  { command: "claude", name: "Claude Code", featured: true },
  { command: "claude-desktop", name: "Claude Desktop (Fireworks inference)", featured: true },
  { command: "opencode", name: "OpenCode", featured: true },
  { command: "codex", name: "Codex CLI", featured: true },
  { command: "chatgpt", name: "ChatGPT desktop app", featured: true },
  { command: "pi", name: "Pi" },
  { command: "cursor", name: "Cursor IDE" },
  { command: "vscode", name: "VS Code Chat" },
  { command: "copilot-app", name: "GitHub Copilot desktop app" },
  { command: "copilot-cli", name: "GitHub Copilot CLI" },
  { command: "deepseek", name: "DeepSeek Harness (dsh)" },
].map(Object.freeze));

/**
 * Resolve a harness alias to its canonical harness id (or return the input
 * unchanged if it is not an alias).
 * @param {string} token
 * @returns {string}
 */
export function resolveHarnessAlias(token) {
  return HARNESS_ALIASES[token] ?? token;
}

/** Codex, OpenCode, Pi, and DeepSeek Harness — file-based configs (literal or legacy env ref). */
export const FILE_CONFIG_HARNESS_IDS = Object.freeze([
  HARNESS.CODEX,
  HARNESS.OPENCODE,
  HARNESS.PI,
  HARNESS.DEEPSEEK,
]);

export const FILE_CONFIG_HARNESS_SET = new Set(FILE_CONFIG_HARNESS_IDS);

/**
 * @param {string} value
 * @returns {HarnessId}
 */
/**
 * `copilot` names two different products, so it is never guessed at — the
 * error says which is which instead of silently picking one.
 */
export const AMBIGUOUS_COPILOT_MESSAGE =
  "`copilot` is ambiguous — GitHub ships two products:\n"
  + "  nexus copilot-app    GitHub Copilot desktop app\n"
  + "  nexus copilot-cli    GitHub Copilot CLI (the `copilot` command)";

export function parseHarnessId(value) {
  if (value === "copilot") {
    throw new Error(AMBIGUOUS_COPILOT_MESSAGE);
  }
  if (!HARNESSES.includes(value)) {
    throw new Error(`Unknown harness: ${value}. Choose one of: ${HARNESSES.join(", ")}`);
  }
  return value;
}

/**
 * @param {string} value
 * @returns {HarnessId[]}
 */
export function parseHarnessIdList(value) {
  const ids = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("At least one harness id is required");
  }
  return ids.map(parseHarnessId);
}
