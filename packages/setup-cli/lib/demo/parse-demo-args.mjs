/**
 * Argument parser for `nexus claude demo`.
 *
 * Lives in the demo folder on purpose: the shared CLI parser (`../parse-args.mjs`)
 * carries no demo-*specific* flag knowledge — its only demo touchpoint is a
 * one-line delegation to `parseDemoArgs`. Keeping the whole grammar here means
 * the demo can be lifted out (or dropped in) without editing the mainline parser.
 *
 * Demo-specific flags (`--prompt`, `--challenger`, …) are handled here; the
 * command-agnostic global flags (`--json`, `--home`, `--api-key`, `--mode`, …)
 * are delegated to `applyGlobalFlag` so that knowledge stays in exactly one place
 * and `nexus claude demo` accepts the same global flags as every other command.
 *
 * Top-level `nexus demo` is deprecated but still parsed here for compatibility.
 */

import { applyGlobalFlag, createBaseContext } from "../cli/parse-args.mjs";

const DEMO_PROMPT_PRESETS = new Set(["tetris", "snake", "clock", "custom"]);

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value. Run: nexus claude help`);
  }
  return value;
}

/**
 * Skip consecutive global flags starting at `start`, returning the next index.
 * @param {string[]} argv
 * @param {number} start
 * @returns {number}
 */
function skipLeadingGlobalFlags(argv, start) {
  let i = start;
  const scratch = createBaseContext();
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      break;
    }
    let consumed;
    try {
      consumed = applyGlobalFlag(scratch, arg, argv[i + 1]);
    } catch {
      break;
    }
    if (consumed === true) {
      i += 2;
    } else if (consumed === false) {
      i += 1;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Locate a demo invocation in argv, tolerating leading global flags and flags
 * between `claude` and `demo` (same as other Claude subcommands).
 * @param {string[]} argv
 * @returns {{ deprecated: boolean, rest: string[] } | null}
 */
export function findDemoInvocation(argv) {
  const scratch = createBaseContext();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V") {
      return null;
    }
    if (!arg.startsWith("-")) {
      if (arg === "demo") {
        return {
          deprecated: true,
          rest: argv.slice(0, i).concat(argv.slice(i + 1)),
        };
      }
      if (arg === "claude") {
        const demoIndex = skipLeadingGlobalFlags(argv, i + 1);
        if (argv[demoIndex] === "demo") {
          return {
            deprecated: false,
            rest: argv.slice(0, i).concat(argv.slice(i + 1, demoIndex)).concat(argv.slice(demoIndex + 1)),
          };
        }
      }
      return null;
    }
    let consumed;
    try {
      consumed = applyGlobalFlag(scratch, arg, argv[i + 1]);
    } catch {
      return null;
    }
    if (consumed === true) {
      i += 1;
    } else if (consumed === null) {
      return null;
    }
  }
  return null;
}

/**
 * @param {string[]} rest  argv with `demo` or `claude demo` removed
 * @param {import("../harness/types.mjs").HarnessContext} ctx  a fresh base context
 * @returns {{ kind: "demo", ctx: object, deprecated?: boolean }
 *   | { kind: "global", command: "help"|"version", ctx: object, helpTopic?: string }}
 */
export function parseDemoArgs(rest, ctx, { deprecated = false } = {}) {
  // Demo-specific defaults — the shared base context doesn't declare these.
  ctx.prompt = "";
  ctx.promptFile = "";
  ctx.leftModel = "";
  ctx.rightModel = "";
  ctx.challenger = "";
  ctx.anthropicModel = "";
  ctx.noOpen = false;
  ctx.out = "";
  ctx.yes = false;
  ctx.clean = false;

  // The single positional: a prompt preset, or the `clean` maintenance
  // subcommand (which removes generated output rather than racing).
  let positional = "";
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];

    if (arg === "--help" || arg === "-h") {
      return { kind: "global", command: "help", ctx, helpTopic: "demo" };
    }

    // `nexus claude demo --version` mirrors every other subcommand: print the
    // CLI version instead of falling through to "Unknown argument: --version".
    if (arg === "--version" || arg === "-V") {
      return { kind: "global", command: "version", ctx };
    }

    // Demo-specific flags.
    if (arg === "--prompt") {
      ctx.prompt = requireValue(arg, next); i += 1; continue;
    }
    if (arg === "--prompt-file") {
      ctx.promptFile = requireValue(arg, next); i += 1; continue;
    }
    if (arg === "--left-model") {
      ctx.leftModel = requireValue(arg, next); i += 1; continue;
    }
    if (arg === "--right-model") {
      ctx.rightModel = requireValue(arg, next);
      ctx.challenger = ctx.rightModel;
      i += 1; continue;
    }
    if (arg === "--challenger") {
      ctx.challenger = requireValue(arg, next);
      ctx.rightModel = ctx.challenger;
      i += 1; continue;
    }
    if (arg === "--anthropic-model") {
      ctx.anthropicModel = requireValue(arg, next);
      ctx.leftModel = ctx.anthropicModel;
      i += 1; continue;
    }
    if (arg === "--out") {
      ctx.out = requireValue(arg, next); i += 1; continue;
    }
    if (arg === "--no-open") {
      ctx.noOpen = true; continue;
    }
    if (arg === "--yes") {
      ctx.yes = true; continue;
    }

    // Command-agnostic global flags (--json, --home, --api-key, --mode, …).
    let consumed;
    try {
      consumed = applyGlobalFlag(ctx, arg, next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        message.includes("Run: nexus")
          ? message
          : `${message} Run: nexus help`,
      );
    }
    if (consumed === true) {
      i += 1; continue;
    }
    if (consumed === false) {
      continue;
    }

    // Not a flag → the sole positional.
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}. Run: nexus help`);
    }
    if (positional) {
      throw new Error(ctx.clean
        ? "nexus claude demo clean takes no preset. Run: nexus claude help"
        : "nexus claude demo takes an optional preset, not subcommands. Run: nexus claude help");
    }
    if (arg === "clean") {
      ctx.clean = true;
    }
    positional = arg;
  }

  if (ctx.providersFromFlag || ctx.autoReset) {
    throw new Error("--providers/--reset apply only to `nexus auto`. Run: nexus auto --help");
  }

  if (ctx.clean) {
    return { kind: "demo", ctx, deprecated };
  }

  // `nexus claude demo [preset]` — the positional preset folds into ctx.prompt,
  // mirroring `--prompt`. An explicit --prompt wins over the positional.
  if (positional) {
    if (!DEMO_PROMPT_PRESETS.has(positional)) {
      throw new Error(
        `Unknown demo preset: ${positional}. Choose one of: `
          + `${[...DEMO_PROMPT_PRESETS].join(", ")}. Run: nexus claude help`,
      );
    }
    if (!ctx.prompt) {
      ctx.prompt = positional;
    }
  }
  return { kind: "demo", ctx, deprecated };
}
