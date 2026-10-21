/**
 * Shared re-`on` refresh policy for Nexus-managed picker catalogs.
 *
 * Every harness stores its catalog in its own format — a JSON catalog file
 * (codex), provider model maps (opencode / copilot CLI), SQLite rows (copilot app),
 * Electron-state arrays (vscode, cursor), a models.json provider block (pi) —
 * but the refresh POLICY is one:
 *
 *   1. prune ids the provider no longer serves,
 *   2. keep gateway specials (the synthesized `auto` mix, FireRouter paths,
 *      per the caller's keepUnserved predicate),
 *   3. register newly served ids,
 *   4. re-render fresh metadata (price, context window, display name) for kept
 *      rows — the caller does this when applying the plan.
 *
 * Harnesses plug in their own parsing (how currentIds are read out of their
 * storage format, normalized into the same id space as freshIds) and their own
 * row building (how added/kept ids become storage rows); this module owns only
 * the id-set plan so all harnesses follow the same interface.
 *
 * Fresh-install policy (enforced alongside the refresh policy so every
 * harness behaves the same): a fresh `on` always seeds the whole fetched
 * catalog, even when `--model` pins one row — `--model` selects the active
 * model, it never narrows the picker menu. The selected model is ensured
 * present (appended/synthesized when the fetch doesn't list it). Re-`on`
 * with `--model` keeps the existing registry and only ensures the selection.
 *
 * @param {object} args
 * @param {string[]} args.currentIds ids currently registered (normalized)
 * @param {string[]} args.freshIds ids the provider serves now (same id space)
 * @param {(id: string) => boolean} [args.keepUnserved] keep a current id even
 *   though the provider doesn't list it (auto mix, FireRouter paths, …).
 *   Default: drop it.
 * @returns {{ kept: string[], pruned: string[], added: string[] }}
 */
export function planCatalogRefresh({ currentIds = [], freshIds = [], keepUnserved = () => false } = {}) {
  const freshSet = new Set(freshIds.filter(Boolean));
  const kept = [];
  const pruned = [];
  const seen = new Set();
  for (const id of currentIds) {
    if (!id || seen.has(id)) {
      pruned.push(id);
      continue;
    }
    seen.add(id);
    (freshSet.has(id) || keepUnserved(id) ? kept : pruned).push(id);
  }
  const added = [...freshSet].filter((id) => !seen.has(id));
  return { kept, pruned, added };
}
