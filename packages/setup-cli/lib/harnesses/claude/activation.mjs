import { readGlobalConfig } from "../../config/global-config.mjs";
import { claudePathsFor } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { readJsonIfExists } from "../../io/json.mjs";
import { fireworksKeyFromCustomHeaders } from "../../firerouter/core.mjs";
import { isFirePassKey } from "../../keys/key-type.mjs";
import {
  claudeFireconnectIntent,
  providerBackupPath,
  providerStatePath,
} from "./core.mjs";
import {
  mergeClaudeModelMappings,
  migrateLegacyClaudeModelMapping,
  normalizeClaudeProfiles,
  resolveClaudeModelMapping,
  savedClaudeModelMapping,
} from "./model-profile.mjs";
import { CLAUDE_TIER_SLOTS, claudeSlotOverridesFromCtx } from "./connect.mjs";

/** Tier-slot slice of a mapping; `main` stays picker-managed. */
function tierSlotsOf(mapping = {}) {
  return Object.fromEntries(
    CLAUDE_TIER_SLOTS
      .filter((slot) => typeof mapping[slot] === "string" && mapping[slot].trim())
      .map((slot) => [slot, mapping[slot]]),
  );
}

export async function readClaudeActivationSnapshot(ctx) {
  const paths = claudePathsFor(ctx);
  const [settings, backup, state, globalConfig] = await Promise.all([
    readJsonIfExists(paths.settingsPath),
    readJsonIfExists(providerBackupPath(paths.dataDir)),
    readJsonIfExists(providerStatePath(paths.dataDir)),
    readGlobalConfig(ctx.home),
  ]);
  const intent = claudeFireconnectIntent(settings, { backup, state });
  const rawProfiles = globalConfig.harnesses[HARNESS.CLAUDE]?.profiles;
  return {
    ...paths,
    settings,
    backup,
    state,
    intent,
    profiles: normalizeClaudeProfiles(rawProfiles),
    // Older releases wrote Fire Pass setups; their live pins must not carry over.
    legacyFirePass: state.keyType === "firepass"
      || Boolean(rawProfiles?.firepass)
      || isFirePassKey(fireworksKeyFromCustomHeaders(settings.env?.ANTHROPIC_CUSTOM_HEADERS)),
  };
}

export function resolveClaudeActivationPlan({
  ctx,
  snapshot,
  activeMappingIsCurrent,
}) {
  // Every tier slot defaults to native, but explicit `--opus` … `--subagent`
  // flags pin slots and re-`on` preserves pins saved by an earlier `on` (saved
  // profile, then live settings). Explicit flags win; `native` unpins back to
  // Claude defaults. `--model` stays picker-only.
  const saved = savedClaudeModelMapping(snapshot.profiles);
  const active = snapshot.intent && activeMappingIsCurrent
    ? snapshot.intent.mapping
    : {};
  const overrides = claudeSlotOverridesFromCtx(ctx);
  const migratedSaved = migrateLegacyClaudeModelMapping(saved).mapping;
  const migratedActive = migrateLegacyClaudeModelMapping(active).mapping;
  return {
    mapping: resolveClaudeModelMapping(
      mergeClaudeModelMappings(
        tierSlotsOf(migratedSaved),
        tierSlotsOf(migratedActive),
        overrides,
      ),
    ),
  };
}
