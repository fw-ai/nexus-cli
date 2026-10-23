import {
  firerouterRequiresAnthropicKey,
  isAutoModelId,
  isFirerouterModelPattern,
} from "../../fireworks/model-id.mjs";
import {
  ANTHROPIC_BYOK_BODY_FIELD,
  ANTHROPIC_BYOK_HEADER,
  NEXUS_PROVIDERS_HEADER,
  RETIRED_ROUTING_PREFERENCE_HEADER,
} from "../../firerouter/core.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";

const BYOK_HEADER_NAMES = new Set([
  ANTHROPIC_BYOK_HEADER,
  "x-openai-api-key",
  NEXUS_PROVIDERS_HEADER,
  RETIRED_ROUTING_PREFERENCE_HEADER,
]);

export function withFireconnectRequestHeaders(
  model,
  { telemetryHeaders = {}, byokHeaders = {} } = {},
) {
  // Attach byokHeaders (provider keys and the `nexus auto` scope) to `auto`
  // rows and FireRouter rows; strip the Anthropic key from FireRouter rows
  // that don't route to Anthropic. Pinned models get none.
  const firerouter = isFirerouterModelPattern(model.id);
  const needsAnthropicKey = firerouterRequiresAnthropicKey(model.id);
  const priorHeaders = Object.fromEntries(
    Object.entries(model.requestHeaders ?? {}).filter(
      ([name]) => !BYOK_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
  const attachedByok = firerouter
    ? Object.fromEntries(
        Object.entries(byokHeaders).filter(
          ([name]) => needsAnthropicKey || name.toLowerCase() !== ANTHROPIC_BYOK_HEADER,
        ),
      )
    : isAutoModelId(model.id)
      ? { ...byokHeaders }
      : {};
  const requestHeaders = {
    ...mergeFireconnectTelemetryHeaders(priorHeaders, telemetryHeaders),
    ...attachedByok,
  };
  const next = { ...model };
  if (Object.keys(requestHeaders).length) {
    next.requestHeaders = requestHeaders;
  } else {
    delete next.requestHeaders;
  }
  const anthropicKey = byokHeaders[ANTHROPIC_BYOK_HEADER];
  if (needsAnthropicKey && anthropicKey) {
    next[ANTHROPIC_BYOK_BODY_FIELD] = anthropicKey;
  } else {
    delete next[ANTHROPIC_BYOK_BODY_FIELD];
  }
  return next;
}

export function withFireconnectRequestHeadersForModels(
  models,
  options,
) {
  return models.map((model) => withFireconnectRequestHeaders(model, options));
}
