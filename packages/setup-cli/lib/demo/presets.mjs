/**
 * Prompt presets for `nexus demo`.
 *
 * Each preset produces a single self-contained HTML file (inline CSS/JS, no
 * external deps) so it drops straight into a sandboxed iframe. All are
 * public-domain game/clock concepts — no copyrighted assets or level design.
 */

import { readFile as fsReadFile } from "node:fs/promises";

export const HTML_ONLY_SUFFIX =
  " Return only a single complete HTML file. No explanation, no markdown fences.";

/**
 * Per-run system prompt appended (via `claude -p --append-system-prompt`) to
 * every demo run, so no two races send an identical system prompt.
 *
 * Only the per-run marker remains. The spec text that used to live here (layout
 * sizing, design palette, "this run is timed") was removed: it added input
 * tokens where the open model has the weaker position (GLM pays $2.10/M every
 * run; warm-cached Opus pays $0.50/M), so padding the prompt biased the cost
 * story the wrong way. The output contract ("Return only a single complete HTML
 * file…") already lives in {@link HTML_ONLY_SUFFIX} on each preset.
 *
 * The marker does NOT force a cold cache and should not be relied on for
 * reproducibility: Claude Code's own base system prompt is cached ahead of
 * anything `--append-system-prompt` can reach (measured 0% / 93% / 93% of
 * prompt tokens served from cache across three runs). It is kept because a
 * unique prompt per run is correct benchmark hygiene. compare.html states each
 * side's cache state outright; removing cache luck needs an average over races.
 *
 * @param {string} [runId] injectable for tests
 * @returns {string}
 */
export function demoSystemPrompt(runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`) {
  return `Run ${runId}. (Ignore this line; it only keeps runs comparable.)`;
}

const TETRIS = (
  "Build a complete, playable Tetris in a single HTML file. "
  + "Arrow keys to move, up to rotate, down to soft-drop. "
  + "Show score and next piece. Game-over screen with restart."
  + HTML_ONLY_SUFFIX
);

const SNAKE = (
  "Build a complete, playable Snake in a single HTML file. "
  + "Arrow keys to steer, the tail grows when the snake eats food, "
  + "show the score, and end with a game-over screen and restart."
  + HTML_ONLY_SUFFIX
);

const CLOCK = (
  "Build an animated analog clock in a single HTML file using CSS and JavaScript. "
  + "The hour, minute, and second hands move in real time. Make it look polished."
  + HTML_ONLY_SUFFIX
);

/** @typedef {{ id: string, title: string, prompt: string }} PromptPreset */

export const DEMO_PRESETS = Object.freeze({
  tetris: { id: "tetris", title: "Tetris", prompt: TETRIS },
  snake: { id: "snake", title: "Snake", prompt: SNAKE },
  clock: { id: "clock", title: "Analog Clock", prompt: CLOCK },
});

export const DEFAULT_DEMO_PRESET = "tetris";
export const CUSTOM_DEMO_PROMPT_ID = "custom";

/** Wizard game-picker options, in display order. @returns {string[]} */
export function demoPromptOptionIds() {
  return [...Object.keys(DEMO_PRESETS), CUSTOM_DEMO_PROMPT_ID];
}

/** Short UX hints for the demo wizard game picker. */
export const DEMO_PRESET_HINTS = Object.freeze({
  tetris: "~2–4 min · playable Tetris",
  snake: "~1–3 min · classic Snake",
  clock: "~1 min · animated analog clock",
  [CUSTOM_DEMO_PROMPT_ID]: "Describe any standalone HTML app",
});

/**
 * @param {string} id
 * @returns {PromptPreset}
 */
export function getPreset(id) {
  const preset = DEMO_PRESETS[id];
  if (!preset) {
    throw new Error(
      `Unknown demo preset: ${id}. Choose one of: ${Object.keys(DEMO_PRESETS).join(", ")}`,
    );
  }
  return preset;
}

export function wrapCustomPrompt(prompt) {
  const text = String(prompt ?? "").trim();
  if (!text) {
    return "";
  }
  if (/Return only a single complete HTML file\. No explanation, no markdown fences\.$/i.test(text)) {
    return text;
  }
  return `${text}${HTML_ONLY_SUFFIX}`;
}

/**
 * Resolve the prompt text from a preset id, an explicit prompt string, a raw
 * custom task, or a prompt file path. Precedence: promptFile > custom >
 * prompt (preset name or literal) > default preset.
 *
 * `custom` is a dedicated channel for user-typed custom tasks (e.g. from the
 * setup form). It is always resolved as a literal task — never a preset id and
 * never the custom sentinel — so a task whose text happens to be exactly
 * "custom" runs the demo instead of tripping the empty-custom guard.
 *
 * @param {{ prompt?: string, promptFile?: string, custom?: string, readFile?: (p: string) => Promise<string> }} [args]
 * @returns {Promise<{ title: string, prompt: string, rawPrompt?: string, source: "preset" | "file" | "literal", presetId?: string }>}
 */
export async function resolvePrompt({ prompt = "", promptFile = "", custom = "", readFile } = {}) {
  if (promptFile) {
    const read = readFile ?? defaultReadFile;
    const text = (await read(promptFile)).trim();
    if (!text) {
      throw new Error(`Prompt file is empty: ${promptFile}`);
    }
    return { title: presetTitleFromFilename(promptFile), prompt: wrapCustomPrompt(text), rawPrompt: text, source: "file" };
  }

  const customText = String(custom ?? "").trim();
  if (customText) {
    return {
      title: "Custom prompt",
      prompt: wrapCustomPrompt(customText),
      rawPrompt: customText,
      source: "literal",
      presetId: CUSTOM_DEMO_PROMPT_ID,
    };
  }

  if (prompt) {
    if (prompt === CUSTOM_DEMO_PROMPT_ID) {
      throw new Error("Custom demo prompt requires --prompt <task> or --prompt-file <path>.");
    }
    // A preset id resolves to its canned text; anything else is treated as a
    // literal custom task the user typed/passed. Wrap it in the same standalone
    // HTML output contract as the curated presets so the race compares returned
    // artifacts, not one side's attempt to write a file with Claude Code tools.
    const preset = DEMO_PRESETS[prompt];
    if (preset) {
      return { title: preset.title, prompt: preset.prompt, source: "preset", presetId: preset.id };
    }
    return {
      title: "Custom prompt",
      prompt: wrapCustomPrompt(prompt),
      rawPrompt: prompt,
      source: "literal",
      presetId: CUSTOM_DEMO_PROMPT_ID,
    };
  }

  const preset = getPreset(DEFAULT_DEMO_PRESET);
  return { title: preset.title, prompt: preset.prompt, source: "preset", presetId: preset.id };
}

async function defaultReadFile(p) {
  return fsReadFile(p, "utf8");
}

function presetTitleFromFilename(filePath) {
  const base = String(filePath).split("/").pop() ?? filePath;
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return stem || "Custom prompt";
}
