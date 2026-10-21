/** Marker so nexus can find/remove a legacy SessionStart hook entry. */
export const DESKTOP_GUARD_HOOK_MARKER = "fireconnect-desktop-guard.mjs";

function isOwnHookEntry(entry) {
  return typeof entry?.hooks?.[0]?.command === "string"
    && entry.hooks[0].command.includes(DESKTOP_GUARD_HOOK_MARKER);
}

/**
 * Remove a legacy FireConnect SessionStart desktop-guard hook, leaving other
 * hooks intact. Kept for cleanup on `claude on` / `off` after the guard was
 * retired (CLI-only product; the Desktop half-applied-env warning is unused).
 * @param {Record<string, unknown>} settings
 */
export function withoutDesktopGuardHook(settings) {
  const hooks = settings.hooks;
  if (!hooks?.SessionStart) {
    return settings;
  }
  const sessionStart = hooks.SessionStart.filter((entry) => !isOwnHookEntry(entry));
  const nextHooks = { ...hooks, SessionStart: sessionStart };
  if (sessionStart.length === 0) {
    delete nextHooks.SessionStart;
  }
  if (Object.keys(nextHooks).length === 0) {
    const next = { ...settings };
    delete next.hooks;
    return next;
  }
  return { ...settings, hooks: nextHooks };
}
