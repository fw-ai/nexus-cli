/** WebSearch and WebFetch are supported by the Fireworks Messages endpoint. */
export const GATEWAY_DISABLED_SERVER_TOOLS = Object.freeze([]);
const LEGACY_GATEWAY_DISABLED_SERVER_TOOLS = Object.freeze(["WebSearch", "WebFetch"]);

function deniedLegacyServerTools(settings) {
  const deny = Array.isArray(settings?.permissions?.deny) ? settings.permissions.deny : [];
  return deny.filter((tool) => LEGACY_GATEWAY_DISABLED_SERVER_TOOLS.includes(tool));
}

/**
 * Determine which server tools were denied before Nexus managed the file.
 * Repeat `on` calls must consult the original snapshot: the current file may
 * still contain denials added by older FireConnect releases.
 * @param {Record<string, unknown>} settings
 * @param {Record<string, any>} backup
 */
export function originalSettingsDeniedServerTools(settings, backup = {}) {
  if (backup.snapshot !== undefined) {
    if (!backup.snapshot.existed) {
      return [];
    }
    try {
      return deniedLegacyServerTools(JSON.parse(backup.snapshot.raw));
    } catch {
      return [...LEGACY_GATEWAY_DISABLED_SERVER_TOOLS];
    }
  }
  const legacyValues = backup.topLevel?.values;
  if (legacyValues && Object.hasOwn(legacyValues, "permissions")) {
    return deniedLegacyServerTools({ permissions: legacyValues.permissions });
  }
  if ((backup.topLevel?.missing ?? []).includes("permissions")) {
    return [];
  }
  return deniedLegacyServerTools(settings);
}

/**
 * Remove obsolete Nexus server-tool denials while preserving rules found
 * in the user's original settings. Returns the same object when unchanged.
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, unknown>}
 */
export function reconcileGatewayServerToolDenials(settings, { preserveDeniedTools = [] } = {}) {
  const existingPermissions = settings.permissions && typeof settings.permissions === "object"
    ? settings.permissions
    : null;
  const existingDeny = Array.isArray(existingPermissions?.deny) ? existingPermissions.deny : [];
  const withoutLegacyDenials = existingDeny.filter(
    (tool) => !LEGACY_GATEWAY_DISABLED_SERVER_TOOLS.includes(tool)
      || preserveDeniedTools.includes(tool),
  );
  const nextDeny = [
    ...withoutLegacyDenials,
    ...GATEWAY_DISABLED_SERVER_TOOLS.filter((tool) => !withoutLegacyDenials.includes(tool)),
  ];
  if (nextDeny.length === existingDeny.length
      && nextDeny.every((tool, index) => tool === existingDeny[index])) {
    return settings;
  }
  const nextPermissions = { ...(existingPermissions ?? {}) };
  if (nextDeny.length > 0) {
    nextPermissions.deny = nextDeny;
  } else {
    delete nextPermissions.deny;
  }
  const next = { ...settings };
  if (Object.keys(nextPermissions).length > 0) {
    next.permissions = nextPermissions;
  } else {
    delete next.permissions;
  }
  return next;
}

/**
 * Remove only Nexus's bare server-tool denies while reconstructing a
 * pre-v0.9 baseline without a permission-aware legacy backup.
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, unknown>}
 */
export function withoutGatewayServerToolsDenied(settings) {
  const permissions = settings.permissions;
  if (!permissions || typeof permissions !== "object" || !Array.isArray(permissions.deny)) {
    return settings;
  }
  const deny = permissions.deny.filter(
    (rule) => !GATEWAY_DISABLED_SERVER_TOOLS.includes(rule)
      && !LEGACY_GATEWAY_DISABLED_SERVER_TOOLS.includes(rule),
  );
  if (deny.length === permissions.deny.length) {
    return settings;
  }

  const nextPermissions = { ...permissions };
  if (deny.length > 0) {
    nextPermissions.deny = deny;
  } else {
    delete nextPermissions.deny;
  }
  const next = { ...settings };
  if (Object.keys(nextPermissions).length > 0) {
    next.permissions = nextPermissions;
  } else {
    delete next.permissions;
  }
  return next;
}
