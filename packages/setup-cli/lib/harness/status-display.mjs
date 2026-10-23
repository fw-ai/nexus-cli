import { bold, dim, muted, yesNo } from "../ui.mjs";
import { AZURE_PROVIDER_LABEL } from "../fireworks/azure-core.mjs";
import { isFirerouterModel, isFirerouterModelPattern } from "../fireworks/model-id.mjs";

const HARNESS_LABELS = {
  claude: "Claude Code",
  opencode: "OpenCode",
  codex: "Codex",
  pi: "Pi",
  cursor: "Cursor",
  vscode: "VS Code",
  "copilot-app": "Copilot app",
  "copilot-cli": "Copilot CLI",
  deepseek: "DeepSeek Harness",
};

const AUTH_MODE_LABELS = {
  customHeader: "custom header in settings.json",
  apiKeyHelper: "nexus key export hook",
  env: "settings environment",
  "env-reference": "environment reference in config",
  "runtime-env": "shell environment variable",
  literal: "stored in config",
  missing: "missing",
};

export function formatHarnessTitle(harnessId) {
  return bold(harnessId);
}

/** Provider is the transport/account boundary (fireworks, azure, custom, default, none). */
export function formatProvider(provider) {
  if (provider === "fireworks") {
    return "Fireworks";
  }
  if (provider === "azure") {
    return AZURE_PROVIDER_LABEL;
  }
  return provider ?? "(unset)";
}

export function harnessLabel(harnessId) {
  return HARNESS_LABELS[harnessId] ?? harnessId;
}

export function shortModelId(model) {
  if (!model || typeof model !== "string") {
    return "(unset)";
  }
  const stripped = model.replace(/\[1m\]$/i, "");
  // Keep the firerouter/... routing prefix for compound slugs; collapsing to
  // the last segment would report an id the gateway doesn't serve.
  if (isFirerouterModelPattern(stripped) && !isFirerouterModel(stripped)) {
    return stripped.replace(/^accounts\/fireworks\/(?:models|routers)\//i, "");
  }
  return stripped.split("/").at(-1) || model;
}

function formatAuthDetail(authMode) {
  return AUTH_MODE_LABELS[authMode] ?? authMode;
}

/**
 * Auth line: show wiring when configured (or env-ref exists without a live key);
 * show missing when no key and wiring is literal/absent.
 * @param {string | undefined} authMode
 * @param {boolean} keyConfigured
 */
function formatAuthStatusValue(authMode, keyConfigured) {
  if (authMode === undefined) {
    return yesNo(keyConfigured);
  }
  if (authMode === "missing") {
    return keyConfigured ? formatAuthDetail("runtime-env") : "missing";
  }
  if (!keyConfigured && authMode !== "env-reference") {
    return "missing";
  }
  return formatAuthDetail(authMode);
}

export function harnessConnectionFromProvider(provider) {
  return provider === "fireworks"
    || provider === "azure"
    || provider === "custom";
}

/**
 * Structured human status for `nexus <harness> status`.
 * @param {string} harnessId
 * @param {{
 *   connected?: boolean,
 *   provider?: string,
 *   keyConfigured?: boolean,
 *   authMode?: string,
 *   endpoint?: string|null,
 *   model?: string|null,
 *   modelLabel?: string,
 *   mappingRows?: Array<{ slot: string, value?: string, detail?: string, dim?: boolean }>,
 *   registeredModels?: string[],
 *   keySource?: string,
 * }} [options]
 */
export function printStructuredHarnessStatus(harnessId, {
  connected,
  provider = "default",
  keyConfigured = false,
  authMode,
  endpoint = null,
  model,
  modelLabel = "Model",
  mappingRows = [],
  registeredModels = [],
  keySource = "",
} = {}) {
  /** @type {StatusField[]} */
  const fields = [];
  fields.push({
    label: "Connection",
    value: formatOnOff(connected ?? harnessConnectionFromProvider(provider)),
  });
  fields.push({ label: "Provider", value: formatProvider(provider) });
  // One auth line: when routed with a key in place, the specific key-source
  // text subsumes the generic auth-mode label ("stored in config" adds nothing
  // next to "experimental_bearer_token in config.toml"). A missing credential
  // must still surface as such — keySource is a static location label and
  // doesn't know whether a key is actually present.
  const authValue = keySource && keyConfigured
    ? keySource
    : formatAuthStatusValue(authMode, keyConfigured);
  fields.push({ label: "Auth", value: authValue });
  if (endpoint) {
    fields.push({ label: "Endpoint", value: endpoint });
  }
  if (model !== undefined && mappingRows.length === 0) {
    fields.push({ label: modelLabel, value: shortModelId(model) });
  }

  /** @type {StatusSection[]} */
  const sections = [];
  if (mappingRows.length > 0) {
    sections.push({ title: "Model mapping", rows: mappingRows });
  }
  if (registeredModels.length > 0) {
    sections.push({
      title: "Registered models",
      lines: registeredModels.map((entry) => shortModelId(entry)),
    });
  }

  printHarnessStatus(harnessLabel(harnessId), fields, sections);
}

export function printHarnessTitle(title) {
  console.log(formatHarnessTitle(title));
}

export function printField(label, value) {
  console.log(`${label}: ${value}`);
}

export function printBoolField(label, value) {
  printField(label, yesNo(Boolean(value)));
}

export function printSectionHeader(title) {
  console.log(bold(`${title}:`));
}

export function printMappingRow(slot, value, { dimValue = false, detail = "" } = {}) {
  const display = value ?? "(unset)";
  const formatted = dimValue ? dim(display) : display;
  const suffix = detail ? `  ${dim(detail)}` : "";
  console.log(`  ${bold(String(slot).padEnd(8))} -> ${formatted}${suffix}`);
}

export function formatOnOff(enabled) {
  return enabled ? "on" : dim("off");
}

export function printMutedNote(text) {
  console.log(muted(text));
}

/**
 * @typedef {{ label: string, value?: string, bool?: boolean }} StatusField
 * @typedef {{ slot: string, value?: string, dim?: boolean, detail?: string }} StatusMappingRow
 * @typedef {{ title: string, rows?: StatusMappingRow[], lines?: string[], muted?: boolean }} StatusSection
 */

/**
 * Data-driven harness status printer.
 * @param {string} title
 * @param {StatusField[]} fields
 * @param {StatusSection[]} [sections]
 */
export function printHarnessStatus(title, fields, sections = []) {
  printHarnessTitle(title);
  for (const field of fields) {
    if (field.bool !== undefined) {
      printBoolField(field.label, field.bool);
    } else {
      printField(field.label, field.value ?? "(unset)");
    }
  }
  for (const section of sections) {
    console.log("");
    if (section.muted && section.lines?.length === 1) {
      printMutedNote(section.lines[0]);
      continue;
    }
    printSectionHeader(section.title);
    for (const row of section.rows ?? []) {
      printMappingRow(row.slot, row.value, { dimValue: row.dim, detail: row.detail });
    }
    for (const line of section.lines ?? []) {
      console.log(`  ${line}`);
    }
  }
}
