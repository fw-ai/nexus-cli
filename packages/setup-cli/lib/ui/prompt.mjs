import process from "node:process";
import { accent, bold, dim, primary, symbols } from "../ui.mjs";
import { ANSI } from "./palette.mjs";

const HIDE_CURSOR = ANSI.hideCursor;
const SHOW_CURSOR = ANSI.showCursor;
const CLEAR_LINE = ANSI.clearLine;

const KEY = Object.freeze({
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
  ESC: "\x1b",
  CTRL_C: "\x03",
  ENTER_CR: "\r",
  ENTER_LF: "\n",
  BACKSPACE_DEL: "\x7f",
  BACKSPACE_BS: "\b",
});

export { KEY };

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, "");
}

/** Truncate to the terminal width; drops styling on lines that overflow. */
function fitWidth(line, width) {
  const plain = stripAnsi(line);
  if (plain.length <= width) {
    return line;
  }
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Split a raw stdin chunk into key sequences: CSI escape sequences (arrows,
 * etc.) come out whole; everything else char-by-char.
 *
 * For chunk-boundary safety (arrow keys split across reads), use
 * `createKeyParser()` in the prompt loop instead.
 * @param {string} chunk
 */
export function* splitKeys(chunk) {
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b" && chunk[i + 1] === "[") {
      let j = i + 2;
      while (j < chunk.length && !(chunk[j] >= "@" && chunk[j] <= "~")) {
        j += 1;
      }
      if (j < chunk.length) {
        yield chunk.slice(i, j + 1);
        i = j + 1;
      } else {
        yield chunk.slice(i);
        break;
      }
    } else {
      yield chunk[i];
      i += 1;
    }
  }
}

/** Buffers incomplete CSI sequences across stdin chunks. */
export function createKeyParser() {
  let pending = "";
  return {
    /** @returns {boolean} */
    hasPendingEsc() {
      return pending === "\x1b";
    },
    /** @param {string} chunk @returns {string[]} */
    push(chunk) {
      const keys = [];
      let text = pending + chunk;
      pending = "";
      let i = 0;
      while (i < text.length) {
        if (text[i] === "\x1b") {
          if (text[i + 1] === "[") {
            let j = i + 2;
            while (j < text.length && !(text[j] >= "@" && text[j] <= "~")) {
              j += 1;
            }
            if (j < text.length) {
              keys.push(text.slice(i, j + 1));
              i = j + 1;
            } else {
              pending = text.slice(i);
              return keys;
            }
          } else if (i === text.length - 1) {
            pending = "\x1b";
            return keys;
          } else {
            keys.push("\x1b");
            i += 1;
          }
        } else {
          keys.push(text[i]);
          i += 1;
        }
      }
      return keys;
    },
    /** Flush a buffered lone Esc (or trailing bytes) at chunk/stream end. */
    flush() {
      const keys = [];
      if (pending === "\x1b") {
        keys.push("\x1b");
      } else if (pending) {
        keys.push(...pending);
      }
      pending = "";
      return keys;
    },
  };
}

/**
 * Raw-mode render/keypress loop shared by the prompts below.
 *
 * `renderLines()` returns the current frame; `onKey(seq)` mutates prompt state
 * and returns `{ done: true, value }` to finish, or nothing to re-render. The
 * frame is erased on completion — callers print their own one-line summary.
 *
 * Optional `refreshMs` + `onRefresh` re-draw on a timer (live agent lists).
 *
 * @template T
 * @param {{
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 *   renderLines: () => string[],
 *   onKey: (seq: string) => ({ done: true, value: T } | void),
 *   refreshMs?: number,
 *   onRefresh?: () => void | Promise<void>,
 * }} args
 * @returns {Promise<T>}
 */
export async function runPrompt({
  input = process.stdin,
  output = process.stdout,
  renderLines,
  onKey,
  refreshMs = 0,
  onRefresh,
} = {}) {
  if (!input.isTTY) {
    throw new Error("Interactive prompt requires a TTY");
  }

  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  output.write(HIDE_CURSOR);

  let prevLines = 0;
  let closed = false;
  let refreshing = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let refreshTimer = null;

  const draw = () => {
    if (closed) return;
    // `|| 80`, not `?? 80` — a PTY can report columns as 0.
    const width = Math.max(20, output.columns || 80);
    const lines = renderLines().map((line) => fitWidth(line, width));
    let frame = prevLines > 0 ? `\x1b[${prevLines}A\r` : "\r";
    frame += lines.map((line) => `${CLEAR_LINE}${line}`).join("\n");
    if (lines.length < prevLines) {
      const extra = prevLines - lines.length;
      frame += `\n${(`${CLEAR_LINE}\n`).repeat(extra - 1)}${CLEAR_LINE}\x1b[${extra}A`;
    }
    output.write(`${frame}\n`);
    prevLines = lines.length;
  };
  const erase = () => {
    if (prevLines > 0) {
      output.write(`\x1b[${prevLines}A\r\x1b[J`);
      prevLines = 0;
    }
  };
  const restoreTerminal = () => {
    output.write(SHOW_CURSOR);
    input.setRawMode(false);
    input.pause();
  };

  draw();
  if (refreshMs > 0 && typeof onRefresh === "function") {
    refreshTimer = setInterval(() => {
      if (closed || refreshing) return;
      refreshing = true;
      // Cap the wait: onRefresh reads files, and a read that never settles (a
      // stalled network mount) would leave `refreshing` true forever, silently
      // killing every later tick. Losing one refresh beats freezing the list.
      let timer = null;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(refreshMs * 4, 4000));
      });
      Promise.race([Promise.resolve().then(() => onRefresh()), deadline])
        .then(() => {
          if (!closed) draw();
        })
        .catch(() => { /* keep current frame */ })
        .finally(() => {
          if (timer) clearTimeout(timer);
          refreshing = false;
        });
    }, refreshMs);
  }

  try {
    const parser = createKeyParser();
    /** @type {ReturnType<typeof setImmediate> | null} */
    let escFlush = null;

    return await new Promise((resolve) => {
      const stop = () => {
        if (escFlush) {
          clearImmediate(escFlush);
          escFlush = null;
        }
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
      };

      const handleSeq = (seq) => {
        if (seq === KEY.CTRL_C) {
          closed = true;
          stop();
          erase();
          restoreTerminal();
          output.write("^C\n");
          process.exit(130);
        }
        const result = onKey(seq);
        if (result?.done) {
          stop();
          resolve(result.value);
          return true;
        }
        return false;
      };

      const flushPendingEsc = () => {
        for (const seq of parser.flush()) {
          if (handleSeq(seq)) {
            return;
          }
        }
        draw();
      };

      const onData = (chunk) => {
        if (escFlush) {
          clearImmediate(escFlush);
          escFlush = null;
        }
        for (const seq of parser.push(chunk)) {
          if (handleSeq(seq)) {
            return;
          }
        }
        if (parser.hasPendingEsc()) {
          escFlush = setImmediate(flushPendingEsc);
        } else {
          draw();
        }
      };

      const onEnd = () => flushPendingEsc();

      input.on("data", onData);
      input.on("end", onEnd);
    });
  } finally {
    closed = true;
    if (refreshTimer) clearInterval(refreshTimer);
    erase();
    restoreTerminal();
  }
}

function isEnter(seq) {
  return seq === KEY.ENTER_CR || seq === KEY.ENTER_LF;
}

function isBackspace(seq) {
  return seq === KEY.BACKSPACE_DEL || seq === KEY.BACKSPACE_BS;
}

function isPrintable(seq) {
  return seq.length === 1 && seq >= " " && seq !== "\x7f";
}

/** 1-based menu shortcut; returns the choice index or -1. */
function choiceIndexFromDigit(seq, length) {
  if (seq.length !== 1 || seq < "1" || seq > "9") {
    return -1;
  }
  const idx = Number(seq) - 1;
  return idx < length ? idx : -1;
}

/** Visible slice of `items` keeping `index` inside a `pageSize` window. */
function windowFor(items, index, pageSize) {
  if (items.length <= pageSize) {
    return { start: 0, end: items.length };
  }
  const start = Math.min(Math.max(0, index - Math.floor(pageSize / 2)), items.length - pageSize);
  return { start, end: start + pageSize };
}

function renderRows({ items, index, pageSize, renderRow }) {
  const { start, end } = windowFor(items, index, pageSize);
  const rows = [];
  if (start > 0) {
    rows.push(dim(`  ↑ ${start} more`));
  }
  for (let i = start; i < end; i += 1) {
    rows.push(renderRow(items[i], i === index, i));
  }
  if (end < items.length) {
    rows.push(dim(`  ↓ ${items.length - end} more`));
  }
  return rows;
}

function summaryLine(output, message, answer) {
  output.write(`${primary(symbols.ok)} ${message} ${bold(answer)}\n`);
}

/**
 * Arrow-key single select.
 *
 * @template T
 * @param {{
 *   message: string,
 *   choices: Array<{ name: string, value: T, short?: string }>,
 *   pageSize?: number,
 *   initialIndex?: number,
 *   summary?: boolean,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 * }} args
 * @returns {Promise<T | null>} the chosen value, or null on Esc/q.
 */
export async function promptSelect({
  message,
  choices,
  pageSize = 10,
  initialIndex = 0,
  summary = true,
  input,
  output = process.stdout,
}) {
  let index = Math.min(Math.max(0, initialIndex), Math.max(0, choices.length - 1));

  const value = await runPrompt({
    input,
    output,
    renderLines: () => [
      `${accent("?", output)} ${bold(message)}`,
      ...renderRows({
        items: choices,
        index,
        pageSize,
        renderRow: (choice, active) => (active
          ? `${accent(symbols.pointer, output)} ${choice.name}`
          : `  ${choice.name}`),
      }),
      dim("↑/↓ move · 1-9 select · Enter confirm · Esc cancel"),
    ],
    onKey: (seq) => {
      if (seq === KEY.UP) {
        index = (index - 1 + choices.length) % choices.length;
      } else if (seq === KEY.DOWN) {
        index = (index + 1) % choices.length;
      } else if (isEnter(seq)) {
        return { done: true, value: choices[index] };
      } else {
        const picked = choiceIndexFromDigit(seq, choices.length);
        if (picked >= 0) {
          return { done: true, value: choices[picked] };
        }
      }
      if (seq === KEY.ESC || seq === "q") {
        return { done: true, value: null };
      }
      return undefined;
    },
  });

  if (value === null) {
    return null;
  }
  if (summary) {
    summaryLine(output, message, value.short ?? stripAnsi(value.name));
  }
  return value.value;
}

/**
 * Space-to-toggle multi-select.
 *
 * @template T
 * @param {{
 *   message: string,
 *   choices: Array<{ name: string, value: T, short?: string, checked?: boolean }>,
 *   validate?: (picked: T[]) => true | string,
 *   pageSize?: number,
 *   summary?: boolean,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 * }} args
 * @returns {Promise<T[] | null>} chosen values, or null on Esc/q.
 */
export async function promptCheckbox({ message, choices, validate, pageSize = 10, input, output = process.stdout }) {
  let index = 0;
  let error = "";
  const checked = choices.map((choice) => Boolean(choice.checked));

  const picked = () => choices.filter((_, i) => checked[i]).map((choice) => choice.value);

  const value = await runPrompt({
    input,
    output,
    renderLines: () => [
      `${accent("?", output)} ${bold(message)}`,
      ...renderRows({
        items: choices,
        index,
        pageSize,
        renderRow: (choice, active, i) => {
          const box = checked[i] ? accent(`[${symbols.ok}]`, output) : dim("[ ]");
          return active
            ? `${accent(symbols.pointer, output)} ${box} ${choice.name}`
            : `  ${box} ${choice.name}`;
        },
      }),
      error ? `${dim("Space toggle · Enter confirm · Esc cancel")}  ${accent(error, output)}` : dim("Space toggle · Enter confirm · Esc cancel"),
    ],
    onKey: (seq) => {
      if (seq === KEY.UP) {
        index = (index - 1 + choices.length) % choices.length;
      } else if (seq === KEY.DOWN) {
        index = (index + 1) % choices.length;
      } else if (seq === " ") {
        checked[index] = !checked[index];
        error = "";
      } else if (isEnter(seq)) {
        const verdict = validate ? validate(picked()) : true;
        if (verdict === true) {
          return { done: true, value: picked() };
        }
        error = verdict;
      } else if (seq === KEY.ESC || seq === "q") {
        return { done: true, value: null };
      }
      return undefined;
    },
  });

  if (value === null) {
    return null;
  }
  const names = choices
    .filter((choice, i) => checked[i])
    .map((choice) => choice.short ?? stripAnsi(choice.name));
  summaryLine(output, message, names.join(", "));
  return value;
}

/**
 * Incremental type-to-filter select: printable keys narrow the list live,
 * arrows move, Enter picks the highlighted row.
 *
 * @template T
 * @param {{
 *   message: string,
 *   items: T[],
 *   filter: (items: T[], term: string) => T[],
 *   toChoice: (item: T) => { name: string, short?: string, detail?: string },
 *   pageSize?: number,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 * }} args
 * @returns {Promise<T | null>} the picked item, or null on Esc.
 */
export async function promptSearch({
  message,
  items,
  filter,
  toChoice,
  pageSize = 10,
  summary = true,
  input,
  output = process.stdout,
}) {
  let term = "";
  let index = 0;
  let matches = items;

  const refilter = () => {
    matches = filter(items, term);
    index = Math.min(index, Math.max(0, matches.length - 1));
  };

  const value = await runPrompt({
    input,
    output,
    renderLines: () => {
      const lines = [
        `${accent("?", output)} ${bold(message)} ${term}${accent("▏", output)}`,
      ];
      if (matches.length === 0) {
        lines.push(dim("  (no matches — Backspace to widen)"));
      } else {
        lines.push(...renderRows({
          items: matches,
          index,
          pageSize,
          renderRow: (item, active) => {
            const choice = toChoice(item);
            return active
              ? `${accent(symbols.pointer, output)} ${choice.name}`
              : `  ${choice.name}`;
          },
        }));
        const detail = toChoice(matches[index])?.detail;
        if (detail) {
          lines.push(dim(`  ${detail}`));
        }
      }
      lines.push(dim("Type to filter · ↑/↓ move · Enter select · Esc cancel"));
      return lines;
    },
    onKey: (seq) => {
      if (seq === KEY.UP && matches.length > 0) {
        index = (index - 1 + matches.length) % matches.length;
      } else if (seq === KEY.DOWN && matches.length > 0) {
        index = (index + 1) % matches.length;
      } else if (isEnter(seq)) {
        if (matches.length > 0) {
          return { done: true, value: { item: matches[index] } };
        }
      } else if (seq === KEY.ESC) {
        return { done: true, value: null };
      } else if (isBackspace(seq)) {
        term = term.slice(0, -1);
        refilter();
      } else if (isPrintable(seq)) {
        term += seq;
        refilter();
      }
      return undefined;
    },
  });

  if (value === null) {
    return null;
  }
  const choice = toChoice(value.item);
  if (summary) {
    summaryLine(output, message, choice.short ?? stripAnsi(choice.name));
  }
  return value.item;
}
