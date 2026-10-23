import process from "node:process";
import { FIREWORKS_BASE_URL } from "../fireworks/model-id.mjs";
import { HARNESSES, HARNESS_ALIASES, AMBIGUOUS_COPILOT_MESSAGE, resolveHarnessAlias } from "../harness/id.mjs";
import { parseDemoArgs, findDemoInvocation } from "../demo/parse-demo-args.mjs";
import { withSuggestion } from "../ui.mjs";

const GLOBAL_COMMANDS = new Set([
  "login", "logout", "status", "harnesses", "model", "models", "configure", "auto", "uninstall", "upgrade", "update",
  "help", "key", "banner", "finalize-install",
]);
const KEY_SUBCOMMANDS = new Set(["export"]);
const HARNESS_VERBS = new Set(["on", "off", "status", "usage", "live", "mcp"]);

/**
 * Flags that were renamed/retired, mapped to their current spelling. Typing an
 * old name gets an exact "use X instead" instead of a fuzzy did-you-mean.
 */
const RENAMED_FLAGS = {
  "--main": "--model",
  "--router": "--model auto",
  "--fireworks-only": "--providers fireworks",
  "--model-id": "--model",
  "--anthropic-key": "--anthropic-api-key",
  "--last_n": "--last-n",
};

const RETIRED_FLAG_MESSAGES = {};

export const ROUTING_PREFERENCE_DEPRECATION_MESSAGE =
  "--routing-preference is deprecated and has no effect. Set effort in your harness instead.";

/**
 * Flags that point a harness at its own config file or store, mapped to their
 * context key. `on` skips its install check when any is set, so a new path
 * flag goes here and both the parser and the check pick it up. (`--data-dir`
 * only moves Nexus's backups, so it isn't one.)
 */
export const HARNESS_PATH_FLAGS = Object.freeze({
  "--settings-path": "settingsPath",
  "--config-path": "configPath",
  "--db-path": "dbPath",
  "--vscode-path": "vscodePath",
  "--providers-path": "providersPath",
});

/** Every flag the parser understands — used only for typo suggestions. */
const KNOWN_FLAGS = [
  ...Object.keys(HARNESS_PATH_FLAGS),
  "--help", "--version", "--json", "--home",
  "--data-dir", "--api-key", "--base-url", "--azure", "--provider",
  "--anthropic-api-key", "--openai-api-key", "--unset", "--model", "--opus",
  "--sonnet", "--haiku", "--fable", "--subagent", "--search", "--refresh",
  "--providers", "--reset",
  "--force", "--skip-install-check", "--stored-only",
  "--last-n", "--plain", "--verbose", "--routing-preference", "--session", "--days",
  "--account", "--anthropic", "--openai", "--paste", "--revoke", "--with-token",
  "--interactive", "--non-interactive", "--client-id", "--client-secret",
];

function helpHint(harnessId = "") {
  return harnessId
    ? `Run: nexus ${harnessId} help`
    : "Run: nexus help";
}

function withContextualHelp(message, positionals = []) {
  if (message.includes("Run: nexus")) {
    return message;
  }
  // Echo the typed name (e.g. `chatgpt`) for the help hint when it is a harness
  // or a known alias of one, so alias errors route to the right harness help.
  const token = positionals[0] ?? "";
  const isHarnessOrAlias = HARNESSES.includes(token) || resolveHarnessAlias(token) !== token;
  return `${message} ${helpHint(isHarnessOrAlias ? token : "")}`;
}

/**
 * @typedef {import("../harness/types.mjs").HarnessContext} HarnessContext
 */

/**
 * @returns {HarnessContext}
 */
export function createBaseContext() {
  return {
    home: process.env.HOME ?? "",
    settingsPath: "",
    configPath: "",
    dataDir: "",
    apiKey: "",
    apiKeyFromFlag: false,
    baseUrl: FIREWORKS_BASE_URL,
    baseUrlFromFlag: false,
    azure: false,
    provider: "",
    anthropicKey: "",
    anthropicKeyFromFlag: false,
    openaiKey: "",
    openaiKeyFromFlag: false,
    unsetAnthropicKey: false,
    unsetOpenaiKey: false,
    anthropic: false,
    openai: false,
    main: "",
    opus: "",
    sonnet: "",
    haiku: "",
    fable: "",
    subagent: "",
    search: "",
    refresh: false,
    session: "",
    days: 0,
    lastN: "",
    verbose: false,
    plain: false,
    routingPreferenceDeprecated: false,
    json: false,
    dbPath: "",
    force: false,
    skipInstallCheck: false,
    storedOnly: false,
    vscodePath: "",
    withToken: false,
    revoke: false,
    paste: false,
    account: "",
    onboardingMode: "auto",
    providers: "",
    providersFromFlag: false,
    autoReset: false,
  };
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/**
 * A positive whole number of days for `--days`.
 *
 * Rejects 0 and negatives rather than clamping: `--days 0` reads as "no
 * lookback", and silently treating it as 3 would show sessions the user asked to
 * exclude. Capped at 365 so a stray `--days 99999` cannot walk the whole
 * project history pricing every log it finds.
 */
function requireDays(flag, value) {
  const raw = requireValue(flag, value);
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(`${flag} must be a whole number of days between 1 and 365`);
  }
  return days;
}

/**
 * Apply one global (command-agnostic) flag to `ctx`. Shared by the main parser
 * and the demo parser so global-flag knowledge lives in exactly one place — the
 * demo folder only owns demo-specific flags. Does NOT handle `--help`/`--version`
 * (those short-circuit their callers).
 *
 * @param {object} ctx @param {string} arg @param {string|undefined} next
 * @returns {boolean|null} true = value flag (caller must skip `next`);
 *   false = boolean flag; null = not a global flag (caller decides).
 */
export function applyGlobalFlag(ctx, arg, next) {
  if (Object.hasOwn(HARNESS_PATH_FLAGS, arg)) {
    ctx[HARNESS_PATH_FLAGS[arg]] = requireValue(arg, next);
    return true;
  }
  switch (arg) {
    case "--json": ctx.json = true; return false;
    case "--verbose":
    case "-v": ctx.verbose = true; return false;
    case "--plain": ctx.plain = true; return false;
    // Deprecated: still accepts its value so old commands keep working, then warns.
    case "--routing-preference": requireValue(arg, next); ctx.routingPreferenceDeprecated = true; return true;
    case "--azure": ctx.azure = true; ctx.provider = "azure"; return false;
    case "--force": ctx.force = true; return false;
    case "--skip-install-check": ctx.skipInstallCheck = true; return false;
    case "--client-id": ctx.clientId = requireValue(arg, next); return true;
    case "--client-secret": ctx.clientSecret = requireValue(arg, next); return true;
    case "--stored-only": ctx.storedOnly = true; return false;
    case "--with-token": ctx.withToken = true; return false;
    case "--paste": ctx.paste = true; return false;
    // `login --account <id>`: enterprise SSO sign-in via the account's own
    // identity provider (same semantics as `firectl signin <account-id>`).
    case "--account": ctx.account = requireValue(arg, next); return true;
    case "--revoke": ctx.revoke = true; return false;
    case "--anthropic": ctx.anthropic = true; return false;
    case "--openai": ctx.openai = true; return false;
    case "--unset": {
      const key = requireValue(arg, next);
      if (key === "anthropic-api-key") ctx.unsetAnthropicKey = true;
      else if (key === "openai-api-key") ctx.unsetOpenaiKey = true;
      else throw new Error(`--unset takes anthropic-api-key or openai-api-key, not ${key}.`);
      return true;
    }
    case "--interactive":
      if (ctx.onboardingMode === "skip") {
        throw new Error("--interactive and --non-interactive cannot be used together");
      }
      ctx.onboardingMode = "prompt";
      return false;
    case "--non-interactive":
      if (ctx.onboardingMode === "prompt") {
        throw new Error("--interactive and --non-interactive cannot be used together");
      }
      ctx.onboardingMode = "skip";
      return false;
    case "--providers": ctx.providers = requireValue(arg, next); ctx.providersFromFlag = true; return true;
    case "--reset": ctx.autoReset = true; return false;
    case "--home": ctx.home = requireValue(arg, next); return true;
    case "--data-dir": ctx.dataDir = requireValue(arg, next); return true;
    case "--api-key": ctx.apiKey = requireValue(arg, next); ctx.apiKeyFromFlag = true; return true;
    case "--base-url": ctx.baseUrl = requireValue(arg, next); ctx.baseUrlFromFlag = true; return true;
    case "--provider": ctx.provider = requireValue(arg, next); return true;
    // A bare provider-key flag (no value, or followed by another flag) asks
    // the command to prompt on the TTY instead of taking the key from argv,
    // keeping it out of shell history and the process list.
    case "--anthropic-api-key":
      ctx.anthropicKeyFromFlag = true;
      if (next && !next.startsWith("--")) {
        ctx.anthropicKey = next;
        return true;
      }
      ctx.anthropicKey = "";
      ctx.anthropicKeyPrompt = true;
      return false;
    case "--openai-api-key":
      ctx.openaiKeyFromFlag = true;
      if (next && !next.startsWith("--")) {
        ctx.openaiKey = next;
        return true;
      }
      ctx.openaiKey = "";
      ctx.openaiKeyPrompt = true;
      return false;
    case "--model": ctx.main = requireValue(arg, next); return true;
    case "--opus": ctx.opus = requireValue(arg, next); return true;
    case "--sonnet": ctx.sonnet = requireValue(arg, next); return true;
    case "--haiku": ctx.haiku = requireValue(arg, next); return true;
    case "--fable": ctx.fable = requireValue(arg, next); return true;
    case "--subagent": ctx.subagent = requireValue(arg, next); return true;
    case "--search": ctx.search = requireValue(arg, next); return true;
    case "--refresh": ctx.refresh = true; return false;
    case "--session": ctx.session = requireValue(arg, next); return true;
    case "--days": ctx.days = requireDays(arg, next); return true;
    case "--last-n": ctx.lastN = requireValue(arg, next); return true;
    default: return null;
  }
}

/**
 * @param {string[]} argv
 */
function parseFlagsAndPositionals(argv) {
  const ctx = createBaseContext();
  const positional = [];
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      const explicitTopic = next && !next.startsWith("--") ? next : "";
      return {
        ctx,
        positional,
        help: true,
        helpTopic: explicitTopic || positional[positional.length - 1] || "",
        version: false,
      };
    }

    if (arg === "--version" || arg === "-V") {
      version = true;
      continue;
    }

    let consumed;
    try {
      consumed = applyGlobalFlag(ctx, arg, next);
    } catch (error) {
      throw new Error(withContextualHelp(
        error instanceof Error ? error.message : String(error),
        positional,
      ));
    }
    if (consumed === true) {
      i += 1;
    } else if (consumed === null) {
      if (arg.startsWith("--")) {
        const retiredMessage = RETIRED_FLAG_MESSAGES[arg];
        if (retiredMessage) {
          throw new Error(retiredMessage);
        }
        const renamedTo = RENAMED_FLAGS[arg];
        if (renamedTo) {
          throw new Error(`Unknown argument: ${arg}. Use ${renamedTo} instead.`);
        }
        throw new Error(withContextualHelp(
          withSuggestion(`Unknown argument: ${arg}.`, arg, KNOWN_FLAGS),
          positional,
        ));
      }
      positional.push(arg);
    }
    // consumed === false → a boolean global flag; already applied.
  }

  return { ctx, positional, help: false, helpTopic: "", version };
}

/**
 * @param {string} harnessId
 * @param {string[]} tokens
 */
function parseHarnessRoute(harnessId, tokens) {
  if (tokens.length === 0) {
    return { harnessId, verb: "on", noun: "" };
  }

  const verb = tokens[0];
  if (!HARNESS_VERBS.has(verb)) {
    throw new Error(`${withSuggestion(
      `Unknown harness command: ${tokens.join(" ")}.`,
      verb,
      HARNESS_VERBS,
    )} ${helpHint(harnessId)}`);
  }
  if (tokens.length > 1 && verb !== "mcp") {
    throw new Error(
      `nexus ${harnessId} ${verb} does not accept positional arguments. `
        + helpHint(harnessId),
    );
  }

  return { harnessId, verb, noun: "", args: verb === "mcp" ? tokens.slice(1) : [] };
}

/**
 * @param {string[]} argv
 */
export function parseCli(argv) {
  // `claude demo` (and deprecated top-level `demo`) are self-contained: the full
  // flag grammar lives in the demo folder. Detect either form with leading global
  // flags allowed, then hand off the remainder to parseDemoArgs.
  const demoInvocation = findDemoInvocation(argv);
  if (demoInvocation) {
    return parseDemoArgs(demoInvocation.rest, createBaseContext(), {
      deprecated: demoInvocation.deprecated,
    });
  }

  const { ctx, positional, help, helpTopic, version } = parseFlagsAndPositionals(argv);

  if ((ctx.providersFromFlag || ctx.autoReset) && positional[0] !== "auto") {
    const flag = ctx.providersFromFlag ? "--providers" : "--reset";
    throw new Error(`${flag} applies only to \`nexus auto\`. Run: nexus auto --help`);
  }

  if ((ctx.anthropicKeyPrompt || ctx.openaiKeyPrompt)
    && positional[0] !== "auto" && positional[0] !== "configure") {
    const flag = ctx.anthropicKeyPrompt ? "--anthropic-api-key" : "--openai-api-key";
    throw new Error(`${flag} requires a value`);
  }

  if (version) {
    return { kind: "global", command: "version", ctx };
  }

  if (help) {
    // Keep the raw typed token (e.g. `chatgpt`) so per-harness help echoes the
    // name the user typed; printHelp resolves aliases to the canonical help.
    return { kind: "global", command: "help", ctx, helpTopic };
  }

  // Bare `nexus` opens the interactive launcher (which falls back to
  // help when not attached to a TTY). Help stays reachable via `help`/`--help`.
  if (positional.length === 0) {
    if (ctx.onboardingMode !== "auto") {
      const flag = ctx.onboardingMode === "prompt" ? "--interactive" : "--non-interactive";
      throw new Error(`${flag} applies only to \`nexus claude on\`. Run: nexus help`);
    }
    return { kind: "global", command: "launcher", ctx };
  }

  const first = resolveHarnessAlias(positional[0]);
  const rest = positional.slice(1);

  if (first === "help") {
    return { kind: "global", command: "help", ctx, helpTopic: rest[0] ?? "" };
  }

  if (first === "model") {
    if (rest[0] !== "list" || rest.length !== 1) {
      throw new Error(
        `Unexpected model subcommand: ${rest[0] || "(missing)"}. `
          + "Run: nexus help",
      );
    }
    return { kind: "global", command: "model", modelSubcommand: "list", ctx };
  }

  // `models` is a bare alias for `model list`.
  if (first === "models") {
    if (rest.length !== 0) {
      throw new Error(
        `nexus models does not accept positional arguments. `
          + "Run: nexus help",
      );
    }
    return { kind: "global", command: "model", modelSubcommand: "list", ctx };
  }

  if (GLOBAL_COMMANDS.has(first)) {
    if (ctx.onboardingMode !== "auto") {
      const flag = ctx.onboardingMode === "prompt" ? "--interactive" : "--non-interactive";
      throw new Error(`${flag} applies only to \`nexus claude on\`. Run: nexus help`);
    }
    if (first === "key") {
      const subcommand = rest[0];
      if (!subcommand || !KEY_SUBCOMMANDS.has(subcommand)) {
        throw new Error(
          "Unknown key command. Manage your key with `nexus login`, "
            + "`nexus logout`, or `nexus status`. Run: nexus help",
        );
      }
      if (rest.length > 1) {
        throw new Error(
          `nexus key ${subcommand} does not accept positional arguments. `
            + helpHint(),
        );
      }
      return { kind: "global", command: "key", keySubcommand: subcommand, ctx };
    }
    if (rest.length > 0) {
      throw new Error(`${first} does not accept positional arguments. ${helpHint()}`);
    }
    // `update` is the self-update command; `upgrade` is its bare alias.
    return { kind: "global", command: first === "upgrade" ? "update" : first, ctx };
  }

  // `copilot` names two products, so it is never guessed at — say which.
  if (first === "copilot") {
    throw new Error(AMBIGUOUS_COPILOT_MESSAGE);
  }

  if (HARNESSES.includes(first)) {
    if (rest[0] === "help") {
      // Echo the typed name (e.g. `chatgpt`) in the help, not the canonical id.
      return { kind: "global", command: "help", ctx, helpTopic: positional[0] };
    }
    return { kind: "harness", route: parseHarnessRoute(first, rest), ctx };
  }

  throw new Error(`${withSuggestion(
    `Unknown command: ${first}.`,
    first,
    // Aliases are advertised in help as top-level commands, so typo recovery
    // must know them too (`chatgtp` -> `chatgpt`).
    [...GLOBAL_COMMANDS, ...HARNESSES, ...Object.keys(HARNESS_ALIASES)],
  )} ${helpHint()}`);
}
