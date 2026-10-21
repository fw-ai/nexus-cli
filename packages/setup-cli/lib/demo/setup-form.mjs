/**
 * Multi-step onboarding wizard for `nexus claude demo`.
 */

import {
  BOLD, CYAN, DIM, RED, RESET, REVERSE,
  HIDE_CURSOR, SHOW_CURSOR, HOME_CURSOR, CLEAR_SCREEN, moveTo, CLEAR_LINE,
  padRight,
} from "./ansi.mjs";
import {
  CUSTOM_DEMO_PROMPT_ID,
  DEMO_PRESETS,
  DEMO_PRESET_HINTS,
  demoPromptOptionIds,
} from "./presets.mjs";
import {
  demoModelCatalog,
  demoModelLabel,
  demoModelRates,
  hasDemoTokenRates,
} from "./demo-models.mjs";
import {
  CUSTOM_MATCHUP_ID,
  demoMatchupOptionIds,
  demoMatchupPreset,
} from "./demo-matchups.mjs";
import { DEMO_CANCELLED_MSG } from "./demo-readiness.mjs";

const PROMPT_OPTION_IDS = demoPromptOptionIds();
const MATCHUP_OPTION_IDS = demoMatchupOptionIds();
const CUSTOM_PROMPT_ALLOWED = /[\x20-\x7e]/;
const WIZARD_STEPS = 3;

/** Rough per-side token budget for wizard cost hints. */
const EST_INPUT_TOKENS = 4_000;
const EST_OUTPUT_TOKENS = 8_000;

/** @returns {{ id: string, label: string }[]} */
export function curatedDemoModels() {
  return demoModelCatalog();
}

/** @deprecated */
export function curatedChallengers() {
  return demoModelCatalog().filter((m) => m.kind !== "anthropic");
}

/**
 * @param {{ defaults: object }} args
 */
export function createFormState({ defaults }) {
  const matchupIndex = Math.max(0, MATCHUP_OPTION_IDS.indexOf(defaults.matchupPresetId ?? "subscription-vs-fireworks"));
  const preset = demoMatchupPreset(MATCHUP_OPTION_IDS[matchupIndex]);
  return {
    step: "matchup",
    defaults,
    leftModel: defaults.leftModel,
    rightModel: defaults.rightModel,
    matchupIndex,
    focus: "presets",
    modelFocus: 0,
    promptIndex: Math.max(0, PROMPT_OPTION_IDS.indexOf(defaults.promptPresetId ?? "tetris")),
    customPromptText: defaults.promptSource === "literal" ? (defaults.promptText ?? "") : "",
    error: "",
    done: false,
    quit: false,
    presetApplied: Boolean(preset && MATCHUP_OPTION_IDS[matchupIndex] !== CUSTOM_MATCHUP_ID),
  };
}

function modelField(key, label, current) {
  const ids = curatedDemoModels().map((m) => m.id);
  return ids.includes(current)
    ? { type: "choice", key, label, options: ids, index: Math.max(0, ids.indexOf(current)), compact: true }
    : { type: "readonly", key, label, display: current };
}

function customMatchupIndex() {
  return MATCHUP_OPTION_IDS.indexOf(CUSTOM_MATCHUP_ID);
}

function markCustomIfModelsDrift(state, leftModel, rightModel) {
  const preset = demoMatchupPreset(MATCHUP_OPTION_IDS[state.matchupIndex]);
  if (!preset || preset.leftModel !== leftModel || preset.rightModel !== rightModel) {
    return { ...state, leftModel, rightModel, matchupIndex: customMatchupIndex(), presetApplied: false, error: "" };
  }
  return { ...state, leftModel, rightModel, error: "" };
}

function patchModel(state, key, modelId) {
  if (key === "leftModel") {
    return markCustomIfModelsDrift(state, modelId, state.rightModel);
  }
  return markCustomIfModelsDrift(state, state.leftModel, modelId);
}

function sameModelError(state) {
  return state.leftModel === state.rightModel
    ? "Pick two different models — both sides cannot use the same one."
    : "";
}

function applyMatchupPreset(state, index) {
  const id = MATCHUP_OPTION_IDS[index];
  if (id === CUSTOM_MATCHUP_ID) {
    return { ...state, matchupIndex: index, presetApplied: false, error: "" };
  }
  const preset = demoMatchupPreset(id);
  if (!preset) {
    return state;
  }
  return {
    ...state,
    matchupIndex: index,
    leftModel: preset.leftModel,
    rightModel: preset.rightModel,
    presetApplied: true,
    error: "",
  };
}

function advanceFromMatchup(state) {
  const err = sameModelError(state);
  if (err) {
    return { ...state, error: err };
  }
  return { ...state, step: "game", error: "" };
}

function advanceFromGame(state) {
  if (PROMPT_OPTION_IDS[state.promptIndex] === CUSTOM_DEMO_PROMPT_ID) {
    if (!state.customPromptText.trim()) {
      return { ...state, error: "Enter a custom task before continuing." };
    }
  }
  return { ...state, step: "confirm", error: "" };
}

function tryFinish(state) {
  const err = sameModelError(state);
  if (err) {
    return { ...state, error: err };
  }
  return { ...state, done: true, error: "" };
}

function focusedModelField(state) {
  return state.modelFocus === 0
    ? modelField("leftModel", "Model A", state.leftModel)
    : modelField("rightModel", "Model B", state.rightModel);
}

export function applyKey(state, key) {
  const typingCustomPrompt = state.step === "game"
    && PROMPT_OPTION_IDS[state.promptIndex] === CUSTOM_DEMO_PROMPT_ID;

  if (key === "ctrlc" || key === "escape") {
    return { ...state, quit: true };
  }
  if (key === "q" && !typingCustomPrompt) {
    return { ...state, quit: true };
  }

  if (state.step === "confirm") {
    if (key === "b") {
      return { ...state, step: "game", error: "" };
    }
    if (key === "s") {
      return markCustomIfModelsDrift(state, state.rightModel, state.leftModel);
    }
    if (key === "e") {
      return { ...state, step: "matchup", focus: "presets", error: "" };
    }
    if (key === "enter") {
      return tryFinish(state);
    }
    return state;
  }

  if (key === "b" && state.step === "game" && !typingCustomPrompt) {
    return { ...state, step: "matchup", focus: "presets", error: "" };
  }

  if (state.step === "matchup") {
    if (state.focus === "presets") {
      if (key === "down" || key === "tab") {
        return { ...state, focus: "models", modelFocus: 0, error: "" };
      }
      if (key === "left") {
        return applyMatchupPreset(state, (state.matchupIndex - 1 + MATCHUP_OPTION_IDS.length) % MATCHUP_OPTION_IDS.length);
      }
      if (key === "right") {
        return applyMatchupPreset(state, (state.matchupIndex + 1) % MATCHUP_OPTION_IDS.length);
      }
      if (/^[1-9]$/.test(key)) {
        const n = Number(key) - 1;
        if (n < MATCHUP_OPTION_IDS.length) {
          return applyMatchupPreset(state, n);
        }
        return state;
      }
      if (key === "enter") {
        return advanceFromMatchup(state);
      }
      return state;
    }

    if (key === "up") {
      if (state.modelFocus === 0) {
        return { ...state, focus: "presets", error: "" };
      }
      return { ...state, modelFocus: 0, error: "" };
    }
    if (key === "down") {
      return { ...state, modelFocus: 1, error: "" };
    }
    const field = focusedModelField(state);
    if (field.type === "choice") {
      if (key === "left") {
        const index = (field.index - 1 + field.options.length) % field.options.length;
        return patchModel(state, field.key, field.options[index]);
      }
      if (key === "right") {
        const index = (field.index + 1) % field.options.length;
        return patchModel(state, field.key, field.options[index]);
      }
      if (/^[1-9]$/.test(key)) {
        const n = Number(key) - 1;
        if (n < field.options.length) {
          return patchModel(state, field.key, field.options[n]);
        }
      }
    }
    if (key === "enter") {
      return advanceFromMatchup(state);
    }
    return state;
  }

  if (state.step === "game") {
    if (key === "left") {
      return { ...state, promptIndex: (state.promptIndex - 1 + PROMPT_OPTION_IDS.length) % PROMPT_OPTION_IDS.length, error: "" };
    }
    if (key === "right") {
      return { ...state, promptIndex: (state.promptIndex + 1) % PROMPT_OPTION_IDS.length, error: "" };
    }
    if (/^[1-9]$/.test(key)) {
      const n = Number(key) - 1;
      if (n < PROMPT_OPTION_IDS.length) {
        return { ...state, promptIndex: n, error: "" };
      }
      return state;
    }
    if (PROMPT_OPTION_IDS[state.promptIndex] === CUSTOM_DEMO_PROMPT_ID) {
      if (key === "backspace") {
        return { ...state, customPromptText: state.customPromptText.slice(0, -1), error: "" };
      }
      if (key.length === 1 && CUSTOM_PROMPT_ALLOWED.test(key) && state.customPromptText.length < 1000) {
        return { ...state, customPromptText: state.customPromptText + key, error: "" };
      }
    }
    if (key === "enter") {
      return advanceFromGame(state);
    }
    return state;
  }

  return state;
}

export function estimateRaceCost(leftModel, rightModel, slotMapping = null) {
  const leftRates = demoModelRates(leftModel, slotMapping);
  const rightRates = demoModelRates(rightModel, slotMapping);
  if (!hasDemoTokenRates(leftRates) || !hasDemoTokenRates(rightRates)) {
    return null;
  }
  const sideCost = (rates) => (
    (EST_INPUT_TOKENS * rates.inputPerMillion + EST_OUTPUT_TOKENS * rates.outputPerMillion) / 1_000_000
  );
  const total = sideCost(leftRates) + sideCost(rightRates);
  const low = total * 0.6;
  const high = total * 1.8;
  return { low, high, total };
}

export function formResult(state, ref) {
  const promptId = PROMPT_OPTION_IDS[state.promptIndex];
  let prompt;
  let promptSource;
  if (promptId === CUSTOM_DEMO_PROMPT_ID) {
    const text = state.customPromptText.trim();
    prompt = text || CUSTOM_DEMO_PROMPT_ID;
    promptSource = text ? "literal" : "custom-empty";
  } else {
    prompt = promptId;
    promptSource = "preset";
  }
  const matchupId = MATCHUP_OPTION_IDS[state.matchupIndex];
  const out = ref.defaults.out?.trim() || "./nexus-demo";
  return {
    prompt,
    promptSource,
    leftModel: state.leftModel,
    rightModel: state.rightModel,
    challenger: state.rightModel,
    incumbentModel: state.leftModel,
    matchupPresetId: matchupId,
    promptPresetId: promptId === CUSTOM_DEMO_PROMPT_ID ? "" : promptId,
    out,
  };
}

function matchupLabel(id) {
  if (id === CUSTOM_MATCHUP_ID) {
    return "Custom matchup";
  }
  return demoMatchupPreset(id)?.label ?? id;
}

function promptLabel(id) {
  if (id === CUSTOM_DEMO_PROMPT_ID) {
    return "Custom task";
  }
  return DEMO_PRESETS[id]?.title ?? id;
}

function stepLabel(stepNumber, title) {
  return `${stepNumber}/${WIZARD_STEPS} · ${title}`;
}

function renderModelValue(field, slotMapping = null) {
  if (field.type !== "choice") {
    return `${DIM}${field.display}${RESET}`;
  }
  const cur = demoModelLabel(field.options[field.index]);
  const head = `◂ ${REVERSE}${BOLD}${cur}${RESET} ▸ ${DIM}[${field.index + 1}/${field.options.length}]${RESET}`;
  const rates = demoModelRates(field.options[field.index], slotMapping);
  return hasDemoTokenRates(rates)
    ? `${head}  ${DIM}$${rates.inputPerMillion} / $${rates.outputPerMillion} per Mtok${RESET}`
    : `${head}  ${DIM}pricing after route${RESET}`;
}

function renderMatchupStep(state, labelWidth) {
  const lines = [];
  lines.push(`  ${DIM}${padRight("Step:", labelWidth)}${RESET}${stepLabel(1, "Pick models")}`);
  lines.push("");
  for (let i = 0; i < MATCHUP_OPTION_IDS.length; i += 1) {
    const optId = MATCHUP_OPTION_IDS[i];
    const selected = i === state.matchupIndex;
    const bullet = selected ? `${CYAN}●${RESET}` : `${DIM}○${RESET}`;
    const preset = demoMatchupPreset(optId);
    const title = selected ? `${BOLD}${CYAN}${matchupLabel(optId)}${RESET}` : `${DIM}${matchupLabel(optId)}${RESET}`;
    let line = `  ${bullet} ${DIM}${i + 1}${RESET}  ${title}`;
    if (preset) {
      line += `  ${DIM}${demoModelLabel(preset.leftModel)} vs ${demoModelLabel(preset.rightModel)}${RESET}`;
    }
    lines.push(line);
    if (selected && preset?.description) {
      lines.push(`      ${DIM}${preset.description}${RESET}`);
    }
  }
  lines.push("");
  for (let i = 0; i < 2; i += 1) {
    const key = i === 0 ? "leftModel" : "rightModel";
    const label = i === 0 ? "Model A" : "Model B";
    const active = state.focus === "models" && state.modelFocus === i;
    const field = modelField(key, label, i === 0 ? state.leftModel : state.rightModel);
    const marker = active ? `${CYAN}❯${RESET} ` : "  ";
    lines.push(`  ${marker}${DIM}${padRight(`${label}:`, labelWidth)}${RESET}${renderModelValue(field, state.defaults?.slotMapping)}`);
  }
  lines.push("");
  if (state.focus === "presets") {
    lines.push(`  ${DIM}←/→ presets · ↓ models · 1-${MATCHUP_OPTION_IDS.length} jump · Enter next · q quit${RESET}`);
  } else {
    lines.push(`  ${DIM}←/→ browse · ↑/↓ switch side · ↑ presets · Enter next · q quit${RESET}`);
  }
  return lines;
}

function renderGameStep(state, labelWidth) {
  const lines = [];
  const promptId = PROMPT_OPTION_IDS[state.promptIndex];
  lines.push(`  ${DIM}${padRight("Step:", labelWidth)}${RESET}${stepLabel(2, "Pick a challenge")}`);
  lines.push("");
  for (let i = 0; i < PROMPT_OPTION_IDS.length; i += 1) {
    const id = PROMPT_OPTION_IDS[i];
    const selected = i === state.promptIndex;
    const bullet = selected ? `${CYAN}●${RESET}` : `${DIM}○${RESET}`;
    const title = selected ? `${BOLD}${CYAN}${promptLabel(id)}${RESET}` : `${DIM}${promptLabel(id)}${RESET}`;
    lines.push(`  ${bullet} ${DIM}${i + 1}${RESET}  ${title}`);
    if (selected && DEMO_PRESET_HINTS[id]) {
      lines.push(`      ${DIM}${DEMO_PRESET_HINTS[id]}${RESET}`);
    }
  }
  if (promptId === CUSTOM_DEMO_PROMPT_ID) {
    const text = state.customPromptText;
    const cursor = `${REVERSE} ${RESET}`;
    lines.push("");
    lines.push(`  ${DIM}Custom task:${RESET} ${text ? `${REVERSE}${BOLD}${text}${RESET}${cursor}` : `${DIM}(type your prompt)${RESET}`}`);
  }
  lines.push("");
  lines.push(`  ${DIM}←/→ cycle · Enter next · b back · q quit${RESET}`);
  lines.push(`    ${DIM}${padRight("Matchup:", labelWidth)}${demoModelLabel(state.leftModel)}  vs  ${demoModelLabel(state.rightModel)}${RESET}`);
  return lines;
}

function renderConfirmStep(state, labelWidth) {
  const lines = [];
  const promptId = PROMPT_OPTION_IDS[state.promptIndex];
  const est = estimateRaceCost(state.leftModel, state.rightModel, state.defaults?.slotMapping);
  lines.push(`  ${DIM}${padRight("Step:", labelWidth)}${RESET}${stepLabel(3, "Confirm")}`);
  lines.push("");
  lines.push(`  ${DIM}Challenge:${RESET}  ${BOLD}${promptLabel(promptId)}${RESET}`);
  lines.push(`  ${DIM}Model A:${RESET}   ${BOLD}${demoModelLabel(state.leftModel)}${RESET}`);
  lines.push(`  ${DIM}Model B:${RESET}   ${BOLD}${demoModelLabel(state.rightModel)}${RESET}`);
  lines.push("");
  lines.push(`  ${DIM}Both sides use your Nexus Claude setup. Anthropic slots run real Anthropic; only --model differs.${RESET}`);
  if (est) {
    lines.push(`  ${DIM}Est. cost:${RESET}   ~$${est.low.toFixed(2)}–$${est.high.toFixed(2)} · opens browser when done`);
  } else {
    lines.push(`  ${DIM}Opens browser comparison when the race finishes.${RESET}`);
  }
  lines.push("");
  lines.push(`  ${BOLD}${CYAN}Enter${RESET} start race   ${DIM}s swap · e edit · b back · q quit${RESET}`);
  return lines;
}

export function renderFormLines(state, meta) {
  const labelWidth = 18;
  const lines = [
    "",
    `  ${BOLD}${CYAN}Nexus Demo${RESET}`,
    `  ${DIM}Same prompt, two models — race and compare.${RESET}`,
    "",
  ];

  if (state.step === "matchup") {
    lines.push(...renderMatchupStep(state, labelWidth));
  } else if (state.step === "game") {
    lines.push(...renderGameStep(state, labelWidth));
  } else if (state.step === "confirm") {
    lines.push(...renderConfirmStep(state, labelWidth));
  }

  if (state.error) {
    lines.push("");
    lines.push(`  ${RED}${state.error}${RESET}`);
  }

  lines.push("");
  return lines;
}

export async function runSetupForm({ defaults, stdin = process.stdin, stdout = process.stdout }) {
  let state = createFormState({ defaults });

  let prevLineCount = 0;
  let firstDraw = true;

  const redraw = () => {
    const lines = renderFormLines(state, { cols: stdout.columns || 80 });
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
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
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
      for (let i = 1; i < prevLineCount; i += 1) {
        stdout.write(`${moveTo(i + 1, 1)}${CLEAR_LINE}`);
      }
      stdout.write(HOME_CURSOR);
    };

    const emitKey = (key) => {
      state = applyKey(state, key);
      if (state.quit) {
        cleanup();
        reject(new Error(DEMO_CANCELLED_MSG));
        return;
      }
      if (state.done) {
        cleanup();
        resolve(formResult(state, { defaults }));
        return;
      }
      redraw();
    };

    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      while (buf.length > 0) {
        const ch = buf[0];
        if (ch === "\x1b") {
          if (buf.length >= 3 && buf[1] === "[") {
            const arrow = { A: "up", B: "down", C: "right", D: "left" }[buf[2]];
            if (arrow) {
              buf = buf.slice(3);
              emitKey(arrow);
              continue;
            }
          }
          if (buf.length >= 2 && buf[1] !== "[") {
            buf = buf.slice(1);
            emitKey("escape");
            continue;
          }
          if (buf.length === 1) {
            clearTimeout(escTimer);
            escTimer = setTimeout(() => {
              if (buf === "\x1b") {
                buf = "";
                emitKey("escape");
              }
            }, 40);
            return;
          }
          return;
        }
        if (ch === "\x7f" || ch === "\x08") { buf = buf.slice(1); emitKey("backspace"); continue; }
        if (ch === "\x03") { buf = buf.slice(1); emitKey("ctrlc"); continue; }
        if (ch === "\t") { buf = buf.slice(1); emitKey("tab"); continue; }
        if (ch === "\r" || ch === "\n") { buf = buf.slice(1); emitKey("enter"); continue; }
        buf = buf.slice(1);
        emitKey(ch);
      }
    };

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("latin1");
    stdin.on("data", onData);
  });
}
