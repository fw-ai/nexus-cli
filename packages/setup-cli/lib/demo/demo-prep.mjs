/**
 * Pre-race setup for `nexus claude demo`: readiness gate, catalog warm,
 * onboarding wizard, and preferences.
 */

import { resolveFireworksApiKey } from "../keys/harness-api-key.mjs";
import { warmServerlessPricingCache } from "../fireworks/models.mjs";
import { CUSTOM_DEMO_PROMPT_ID, resolvePrompt, DEMO_PRESETS } from "./presets.mjs";
import { runSetupForm } from "./setup-form.mjs";
import {
  defaultLeftModel,
  defaultRightModel,
  demoModelLabel,
  demoModelRates,
  refreshDemoPickerFromServerlessCatalog,
} from "./demo-models.mjs";
import {
  runReadinessGate,
  formatReadinessError,
  assessDemoReadiness,
  FIRECONNECT_REQUIRED_MSG,
} from "./demo-readiness.mjs";
import { loadDemoWizardDefaults } from "./demo-defaults.mjs";
import { saveDemoPreferences } from "./demo-preferences.mjs";

export { FIRECONNECT_REQUIRED_MSG } from "./demo-readiness.mjs";

export function normalizeOptions(ctx) {
  const leftModel = ctx.leftModel || ctx.anthropicModel || ctx.main || defaultLeftModel();
  const rightModel = ctx.rightModel || ctx.challenger || defaultRightModel();
  return {
    prompt: ctx.prompt,
    promptFile: ctx.promptFile,
    leftModel,
    rightModel,
    challenger: rightModel,
    out: ctx.out || "./nexus-demo",
    noOpen: ctx.noOpen,
    json: ctx.json,
    yes: ctx.yes,
  };
}

export async function assertClaudeFireconnected({ home, settingsPath }) {
  const readiness = await assessDemoReadiness({ home, settingsPath });
  if (!readiness.claudeOn) {
    throw new Error(FIRECONNECT_REQUIRED_MSG);
  }
}

function resolveSideRates(modelId, slotMapping = null) {
  const rates = demoModelRates(modelId, slotMapping);
  if (!rates) {
    throw new Error(
      `Could not resolve pricing for ${modelId}. Pick a model from the demo setup form.`,
    );
  }
  return rates;
}

function cliOverrides(options) {
  return {
    leftModel: options.leftModel !== defaultLeftModel() ? options.leftModel : "",
    rightModel: options.rightModel !== defaultRightModel() ? options.rightModel : "",
  };
}

/**
 * @param {{
 *   ctx: any,
 *   options: ReturnType<typeof normalizeOptions>,
 *   useTui: boolean,
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 * }} args
 */
export async function prepareDemoRun({
  ctx,
  options,
  useTui,
  stdin = process.stdin,
  stdout = process.stdout,
}) {
  const home = ctx.home || process.env.HOME || "";

  if (useTui && !options.yes) {
    const readiness = await runReadinessGate({
      home,
      settingsPath: ctx.settingsPath,
      apiKey: ctx.apiKey,
      stdin,
      stdout,
    });
    const wizardDefaults = await loadDemoWizardDefaults(home, readiness, cliOverrides(options));

    const fwKey = await resolveFireworksApiKey({ apiKey: ctx.apiKey, home });
    if (!fwKey) {
      throw new Error(formatReadinessError(await assessDemoReadiness({ home, apiKey: ctx.apiKey })));
    }

    await warmServerlessPricingCache(fwKey);
    refreshDemoPickerFromServerlessCatalog();

    let prompt = options.prompt || options.promptFile
      ? await resolvePrompt({ prompt: options.prompt, promptFile: options.promptFile })
      : null;

    options.leftModel = wizardDefaults.leftModel;
    options.rightModel = wizardDefaults.rightModel;

    const chosen = await runSetupForm({
      defaults: {
        promptSource: prompt?.source ?? "preset",
        promptPresetId: prompt?.presetId || wizardDefaults.promptPresetId,
        promptText: prompt?.rawPrompt ?? prompt?.prompt ?? "",
        promptTitle: prompt?.title ?? DEMO_PRESETS[wizardDefaults.promptPresetId]?.title ?? "Demo",
        leftModel: options.leftModel,
        rightModel: options.rightModel,
        matchupPresetId: wizardDefaults.matchupPresetId,
        slotMapping: readiness.mapping,
        out: options.out,
      },
      stdin,
      stdout,
    });

    options.leftModel = chosen.leftModel;
    options.rightModel = chosen.rightModel;
    options.challenger = chosen.rightModel;
    prompt = chosen.promptSource === "literal"
      ? await resolvePrompt({ custom: chosen.prompt })
      : await resolvePrompt({ prompt: chosen.prompt });

    if (home) {
      await saveDemoPreferences(home, {
        leftModel: chosen.leftModel,
        rightModel: chosen.rightModel,
        promptPresetId: chosen.promptPresetId || chosen.prompt,
        matchupPresetId: chosen.matchupPresetId,
      });
    }

    return {
      fwKey,
      options,
      prompt,
      leftLabel: demoModelLabel(options.leftModel),
      rightLabel: demoModelLabel(options.rightModel),
      leftRates: resolveSideRates(options.leftModel, readiness.mapping),
      rightRates: resolveSideRates(options.rightModel, readiness.mapping),
    };
  }

  await assertClaudeFireconnected({ home, settingsPath: ctx.settingsPath });

  const readiness = await assessDemoReadiness({ home, settingsPath: ctx.settingsPath, apiKey: ctx.apiKey });

  const fwKey = await resolveFireworksApiKey({ apiKey: ctx.apiKey, home });
  if (!fwKey) {
    throw new Error(formatReadinessError(await assessDemoReadiness({ home, apiKey: ctx.apiKey })));
  }

  await warmServerlessPricingCache(fwKey);
  refreshDemoPickerFromServerlessCatalog();

  const prompt = options.prompt === CUSTOM_DEMO_PROMPT_ID && !options.promptFile
    ? {
      title: "Custom prompt",
      prompt: "",
      rawPrompt: "",
      source: "literal",
      presetId: CUSTOM_DEMO_PROMPT_ID,
    }
    : await resolvePrompt({ prompt: options.prompt, promptFile: options.promptFile });

  return {
    fwKey,
    options,
    prompt,
    leftLabel: demoModelLabel(options.leftModel),
    rightLabel: demoModelLabel(options.rightModel),
    leftRates: resolveSideRates(options.leftModel, readiness.mapping),
    rightRates: resolveSideRates(options.rightModel, readiness.mapping),
  };
}
