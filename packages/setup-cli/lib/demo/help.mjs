/**
 * Help text for `nexus claude demo`.
 *
 * @param {string} cliName  the CLI's display name (e.g. "nexus")
 * @param {{ deprecatedTopLevel?: boolean }} [opts]
 * @returns {string}
 */
export function demoHelpText(cliName, { deprecatedTopLevel = false } = {}) {
  const deprecatedNote = deprecatedTopLevel
    ? `\nDeprecated: \`${cliName} demo\` moved to \`${cliName} claude demo\`.\n`
    : "";
  return `Usage:
  ${cliName} claude demo [prompt] [options]
  ${cliName} claude demo clean [--out <dir>] [--yes]
${deprecatedNote}
Race two models on the same code-generation prompt via Claude Code. Requires
\`nexus claude\`. Interactive runs: pick two models, pick a game,
then watch the split-pane race and open the browser comparison.

  Each side runs \`claude -p\` with your existing Nexus Claude profile —
  same auth and routing as \`nexus claude\`. Only \`--model\` differs
  per side; ~/.claude/settings.json is never modified.

Games: tetris (default), snake, clock, custom.

Options:
  --prompt <preset|task>    Game preset or custom standalone HTML task.
  --prompt-file <path>      Custom task from a file (overrides preset).
  --left-model <model>      Left model (default: opus).
  --right-model <model>     Right model (default: glm-fast-latest).
  --challenger <model>      Alias for --right-model.
  --anthropic-model <alias> Alias for --left-model (opus/sonnet/haiku/fable).
  --api-key <key>           Fireworks API key (defaults to FIREWORKS_API_KEY / config).
  --no-open                 Skip the browser handoff; leave outputs on disk.
  --out <dir>               Output directory (default: ./nexus-demo/).
  --yes                     Non-interactive: skip the setup form.
  --json                    Machine-readable result (skips TUI/browser).

Maintenance:
  ${cliName} claude demo clean     Remove generated output and leftover tmp dirs.`;
}
