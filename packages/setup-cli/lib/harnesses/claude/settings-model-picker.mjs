import { claudeCodeModelId } from "./code-context.mjs";
import {
  isAnthropicModelId,
  isAutoModelId,
  isClaudeModelAlias,
  isClaudeNativeModel,
  isFirerouterModel,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import {
  fireworksModelPickerDescription,
  fireworksModelPickerName,
} from "./picker-labels.mjs";

/** Marker on settings.modelPicker so `off` can remove Nexus rows only. */
export const FIRECONNECT_MODEL_PICKER_MANAGED_KEY = "fireconnectManaged";
export const INVALID_MODEL_PICKER_MESSAGE =
  "Claude Code's modelPicker must be an object whose options are rows with a non-empty model string. "
  + "Nexus CLI did not change it.";

/**
 * @param {unknown} modelPicker
 * @returns {boolean}
 */
export function isFireconnectModelPicker(modelPicker) {
  return Boolean(
    modelPicker
    && typeof modelPicker === "object"
    && !Array.isArray(modelPicker)
    && modelPicker[FIRECONNECT_MODEL_PICKER_MANAGED_KEY] === true,
  );
}

/** Validate the picker before `on` appends Nexus rows to its options list. */
export function validateClaudeModelPicker(settings) {
  if (!Object.hasOwn(settings, "modelPicker")) {
    return;
  }
  const picker = settings.modelPicker;
  const valid = picker
    && typeof picker === "object"
    && !Array.isArray(picker)
    && (picker.options === undefined || (
      Array.isArray(picker.options)
      && picker.options.every((row) => (
        row
        && typeof row === "object"
        && !Array.isArray(row)
        && typeof row.model === "string"
        && row.model.trim()
      ))
    ));
  if (!valid) {
    throw new Error(INVALID_MODEL_PICKER_MESSAGE);
  }
}

/**
 * @param {string} modelId bare or full Fireworks slug
 * @returns {{ model: string, label: string, description: string }}
 */
export function fireconnectModelPickerOption(modelId) {
  const tagged = shortFireworksModelRef(claudeCodeModelId(modelId));
  return {
    model: tagged,
    label: fireworksModelPickerName(modelId),
    description: fireworksModelPickerDescription(modelId),
  };
}

/**
 * Build Claude Code `modelPicker.options` for the registerable catalog.
 * @param {string[]} registerableIds bare slugs / router ids (in display order)
 * @returns {{ model: string, label: string, description: string }[]}
 */
export function buildFireconnectModelPickerOptions(registerableIds = []) {
  const seen = new Set();
  /** @type {{ model: string, label: string, description: string }[]} */
  const options = [];
  for (const id of registerableIds) {
    const normalized = typeof id === "string"
      ? shortFireworksModelRef(normalizeModelId(id))
      : "";
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    options.push(fireconnectModelPickerOption(normalized));
  }
  return options;
}

/** Canonical picker-row id: bare slug, `[1m]` stripped, full refs shortened. */
function pickerRowId(row) {
  return typeof row?.model === "string"
    ? shortFireworksModelRef(normalizeModelId(row.model))
    : "";
}

/** Claude's own rows: concrete `claude-*` ids and the tier aliases. */
function isClaudePickerRow(id) {
  return Boolean(id) && (isAnthropicModelId(id) || isClaudeModelAlias(id));
}

/**
 * Merge Nexus rows into the picker. Model ids are canonicalized first, so
 * full, short, bare, and `[1m]` forms dedupe.
 *
 * Default (first connect, or a picker Nexus does not manage): preserve every
 * existing row and append only the missing Nexus rows, so a user-authored
 * picker is never rewritten.
 *
 * With `refresh` (a Fireworks-routed re-`on`, or the upgrade migration on a
 * managed picker) the contract is: `claude-*` rows are Claude's and are kept
 * verbatim; every other row is Nexus territory and is rebuilt from the
 * current serverless catalog — delisted rows are pruned, newly served rows
 * are added, and kept rows are re-rendered with fresh labels, pricing, and
 * context tags. Ids the caller passes as `protectedIds` (this run's
 * `--model`) survive the rebuild even though the catalog does not list
 * them; `firerouter/*` rows never do — FireRouter selections are retired,
 * so a refresh prunes them like any other delisted row.
 *
 * @param {Record<string, unknown>} settings
 * @param {string[]} registerableIds
 * @param {{ refresh?: boolean, protectedIds?: string[] }} [opts]
 * @returns {Record<string, unknown>}
 */
export function withFireconnectModelPicker(settings, registerableIds, { refresh = false, protectedIds = [] } = {}) {
  if (!Object.hasOwn(settings, "modelPicker")) {
    const options = buildFireconnectModelPickerOptions([
      ...registerableIds,
      ...protectedIds,
    ]);
    if (!options.length) {
      return settings;
    }
    return {
      ...settings,
      modelPicker: {
        [FIRECONNECT_MODEL_PICKER_MANAGED_KEY]: true,
        replaceBuiltInOptions: false,
        options,
      },
    };
  }
  validateClaudeModelPicker(settings);
  const existing = settings.modelPicker;
  const existingOptions = existing.options ?? [];

  if (!refresh) {
    const options = buildFireconnectModelPickerOptions([
      ...registerableIds,
      ...protectedIds,
    ]);
    if (!options.length) {
      return settings;
    }
    const present = new Set(existingOptions.map(pickerRowId).filter(Boolean));
    const missing = [];
    for (const row of options) {
      const id = pickerRowId(row);
      if (!id || present.has(id)) {
        continue;
      }
      present.add(id);
      missing.push(row);
    }
    if (!missing.length) {
      return settings;
    }
    return {
      ...settings,
      modelPicker: {
        ...existing,
        options: [...existingOptions, ...missing],
      },
    };
  }

  // A catalog with no served rows is never a reason to prune. Live callers
  // synthesize the `auto` row when the catalog is non-empty (and older ones
  // synthesized bare `firerouter`), so emptiness must be judged after
  // removing those gateway specials: an unreachable or vacant catalog
  // leaves the picker untouched.
  const hasServedCatalogRow = registerableIds.some((id) => {
    const normalized = typeof id === "string"
      ? shortFireworksModelRef(normalizeModelId(id))
      : "";
    return Boolean(normalized) && !isFirerouterModel(normalized) && !isAutoModelId(normalized);
  });
  if (!hasServedCatalogRow) {
    return settings;
  }
  const keptClaudeRows = [];
  const keptIds = new Set();
  for (const row of existingOptions) {
    const id = pickerRowId(row);
    if (!id || keptIds.has(id)) {
      continue;
    }
    if (isClaudePickerRow(id)) {
      keptIds.add(id);
      keptClaudeRows.push(row);
    }
  }
  const extraIds = [...protectedIds]
    .map((id) => (typeof id === "string"
      ? shortFireworksModelRef(normalizeModelId(id))
      : ""))
    // A concrete claude-* protection (this run's --model, the saved default)
    // is rendered like any other protected row; tier aliases and the native
    // sentinel name Claude's own rows and are never synthesized.
    .filter((id) => id && !isClaudeModelAlias(id) && !isClaudeNativeModel(id));
  const refreshed = buildFireconnectModelPickerOptions([
    ...registerableIds,
    ...extraIds,
  ]).filter((row) => !keptIds.has(pickerRowId(row)));
  if (!refreshed.length && !keptClaudeRows.length) {
    return settings;
  }
  // Claude rows lead the picker, including a protected claude-* row rendered
  // for the first time — otherwise it would jump segments on the next refresh.
  const refreshedClaudeRows = refreshed.filter((row) => isClaudePickerRow(pickerRowId(row)));
  const refreshedFireworksRows = refreshed.filter((row) => !isClaudePickerRow(pickerRowId(row)));
  const options = [...keptClaudeRows, ...refreshedClaudeRows, ...refreshedFireworksRows];
  if (JSON.stringify(options) === JSON.stringify(existingOptions)) {
    return settings;
  }
  return {
    ...settings,
    modelPicker: {
      ...existing,
      options,
    },
  };
}

/**
 * @param {Record<string, unknown>} settings
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 */
export function stripFireconnectModelPicker(settings) {
  if (!isFireconnectModelPicker(settings?.modelPicker)) {
    return { settings, changed: false };
  }
  const next = { ...settings };
  delete next.modelPicker;
  return { settings: next, changed: true };
}
