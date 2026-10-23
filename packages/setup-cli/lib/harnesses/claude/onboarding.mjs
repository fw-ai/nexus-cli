import process from "node:process";

import { ANSI, accent, paint } from "../../ui.mjs";
import { formatClaudeSlotModelLabel, isClaudeNativeModel } from "../../fireworks/model-id.mjs";

export function printClaudePickerSummary({
  extraPickerModel = null,
  mapping = null,
  catalogShown = true,
} = {}, output = process.stdout) {
  output.write(`${paint(ANSI.bold, "Model picker", output)}\n`);
  const pins = mapping
    ? Object.entries(mapping).filter(([, modelId]) => modelId && !isClaudeNativeModel(modelId))
    : [];
  if (pins.length > 0) {
    for (const [slot, modelId] of pins) {
      output.write(`  ${paint(ANSI.muted, `Tier slot ${slot}`, output)} ${accent("→", output)} ${accent(formatClaudeSlotModelLabel(modelId), output)}\n`);
    }
  } else {
    output.write(`  ${paint(ANSI.muted, "Anthropic model slots", output)} ${accent("→ unchanged", output)}\n`);
  }
  const catalogState = catalogShown ? "→ appended in /model" : "→ needs a newer Claude Code";
  output.write(`  ${paint(ANSI.muted, "Fireworks catalog", output)} ${accent(catalogState, output)}\n`);
  if (extraPickerModel) {
    output.write([
      "  ",
      paint(ANSI.muted, "Added via --model", output),
      ` ${accent("→", output)} `,
      accent(formatClaudeSlotModelLabel(extraPickerModel), output),
      "\n",
    ].join(""));
  }
  output.write("\n");
}
