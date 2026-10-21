/**
 * Surgical edits to Codex config.toml — only touches Nexus-owned keys/tables
 * so array-of-tables and other non-flat TOML is preserved.
 */

const CODEX_PROVIDER_TABLE_HEADER = "[model_providers.fireworks-ai]";
const CODEX_AZURE_PROVIDER_TABLE_HEADER = "[model_providers.fireworks-azure]";
const LEGACY_PROFILE_TABLE_HEADER = "[profiles.fireconnect]";
const LEGACY_FIRECONNECT_PROFILE_LINE = /^profile\s*=\s*["']fireconnect["']\s*$/;

const ROOT_PROFILE_LINE = /^profile\s*=.+$/;
const ROOT_MODEL_PROVIDER_LINE = /^model_provider\s*=.+$/;
const ROOT_MODEL_LINE = /^model\s*=.+$/;
const ROOT_MODEL_CATALOG_LINE = /^model_catalog_json\s*=.+$/;
// fireconnect-owned cleanup: removes only the stale web_search = "disabled"
// override written by earlier releases (#320) so re-enabling restores defaults.
// User-set values (live, cached, …) are not fireconnect-owned and are kept.
const ROOT_WEB_SEARCH_DISABLED_LINE = /^web_search\s*=\s*["']disabled["']\s*(#.*)?$/;
const CODEX_BEARER_AUTH_LINE = /^experimental_bearer_token\s*=.+$/;
const CODEX_ENV_AUTH_LINE = /^env_key\s*=.+$/;
const CODEX_HTTP_HEADERS_LINE = /^http_headers\s*=.+$/;

function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function inlineTableLine(key, entries) {
  return `${key} = { ${Object.entries(entries)
    .map(([header, value]) => `${tomlString(header)} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function httpHeadersLine(httpHeaders) {
  return inlineTableLine("http_headers", httpHeaders);
}

/**
 * With `chatgptLogin`, Codex authenticates with its own ChatGPT sign-in
 * (`requires_openai_auth = true` sends that login as Authorization, and Codex
 * ignores env_key), so the Fireworks key rides in `http_headers` instead — see
 * CODEX_CHATGPT_FIREWORKS_KEY_HEADER. No bearer token is written: Codex prefers
 * one over the ChatGPT login.
 */
function providerAuthLines({ literal, apiKey, envKey = "FIREWORKS_API_KEY", chatgptLogin = false }) {
  if (chatgptLogin) {
    return ["requires_openai_auth = true"];
  }
  if (literal && apiKey) {
    return [
      `experimental_bearer_token = "${apiKey}"`,
      "requires_openai_auth = false",
    ];
  }
  return [
    `env_key = "${envKey}"`,
    "requires_openai_auth = false",
  ];
}

function isAnyTableHeader(trimmed) {
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function isManagedTableHeader(trimmed) {
  return trimmed === CODEX_PROVIDER_TABLE_HEADER
    || trimmed === CODEX_AZURE_PROVIDER_TABLE_HEADER
    || trimmed === LEGACY_PROFILE_TABLE_HEADER;
}

function ensureTrailingNewline(text) {
  if (!text) {
    return "";
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

function rootHasMatchingLine(raw, pattern) {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (isAnyTableHeader(trimmed)) {
      break;
    }
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} raw
 * @param {(args: { line: string, trimmed: string }) => "keep" | "drop" | string} onRootLine
 * @param {{ afterRootLine?: (args: { line: string, trimmed: string, out: string[] }) => void }} [hooks]
 */
function transformRootLines(raw, onRootLine, hooks = {}) {
  const lines = raw.split("\n");
  const out = [];
  let atRoot = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (atRoot) {
      const result = onRootLine({ line, trimmed });
      if (result === "drop") {
        // omit line
      } else if (result === "keep") {
        out.push(line);
      } else if (typeof result === "string") {
        out.push(result);
      } else {
        out.push(line);
      }
      hooks.afterRootLine?.({ line, trimmed, out });
    } else {
      out.push(line);
    }
    if (atRoot && isAnyTableHeader(trimmed)) {
      atRoot = false;
    }
  }

  return ensureTrailingNewline(out.join("\n"));
}

/**
 * Remove only the stale root override written by FireConnect 0.9.6.
 * @param {string} raw
 */
export function stripStaleCodexWebSearchDisabledRaw(raw) {
  if (!rootHasMatchingLine(raw, ROOT_WEB_SEARCH_DISABLED_LINE)) {
    return raw;
  }
  return transformRootLines(raw, ({ trimmed }) => (
    ROOT_WEB_SEARCH_DISABLED_LINE.test(trimmed) ? "drop" : "keep"
  ));
}

/**
 * @param {string} raw
 * @param {{ stripRootRouting?: boolean }} [options]
 */
export function stripFireconnectRoutingRaw(raw, { stripRootRouting = false } = {}) {
  const lines = raw.split("\n");
  const out = [];
  let skippingTable = false;
  let atRoot = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (LEGACY_FIRECONNECT_PROFILE_LINE.test(trimmed)) {
      continue;
    }
    if (atRoot && stripRootRouting) {
      if (ROOT_PROFILE_LINE.test(trimmed)
        || ROOT_MODEL_PROVIDER_LINE.test(trimmed)
        || ROOT_MODEL_CATALOG_LINE.test(trimmed)
        || ROOT_MODEL_LINE.test(trimmed)
        || ROOT_WEB_SEARCH_DISABLED_LINE.test(trimmed)) {
        continue;
      }
    }
    if (isAnyTableHeader(trimmed)) {
      atRoot = false;
    }
    if (isManagedTableHeader(trimmed)) {
      skippingTable = true;
      continue;
    }
    if (skippingTable) {
      if (isAnyTableHeader(trimmed)) {
        skippingTable = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }

  return ensureTrailingNewline(out.join("\n").replace(/\n+$/, "\n"));
}

/**
 * @param {string} raw
 * @param {{
 *   providerId: string,
 *   baseUrl: string,
 *   modelId: string,
 *   catalogPath?: string,
 *   apiKey?: string,
 *   literalAuth?: boolean,
 *   wireApi?: string,
 *   providerName?: string,
 *   authEnvKey?: string,
 *   httpHeaders?: Record<string, string>,
 *   envHttpHeaders?: Record<string, string>,
 *   chatgptLogin?: boolean,
 * }} routing
 */
export function patchFireconnectRoutingRaw(raw, {
  providerId,
  baseUrl,
  modelId,
  catalogPath = "",
  apiKey = "",
  literalAuth = false,
  wireApi = "responses",
  providerName = "Fireworks",
  authEnvKey = "FIREWORKS_API_KEY",
  httpHeaders = {},
  envHttpHeaders = {},
  chatgptLogin = false,
}) {
  // Leading blank lines are the separator a previous patch wrote after the
  // routing block; keeping them would add one more on every re-`on`.
  const base = stripFireconnectRoutingRaw(raw, { stripRootRouting: true }).replace(/^(?:[ \t]*\r?\n)+/, "");
  const routingBlock = [
    `model_provider = "${providerId}"`,
    ...(catalogPath ? [`model_catalog_json = "${catalogPath}"`] : []),
    `model = "${modelId}"`,
  ].join("\n");
  const tablesBlock = [
    `[model_providers.${providerId}]`,
    `name = "${providerName}"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "${wireApi}"`,
    ...providerAuthLines({ literal: literalAuth, apiKey, envKey: authEnvKey, chatgptLogin }),
    ...(Object.keys(httpHeaders).length ? [httpHeadersLine(httpHeaders)] : []),
    ...(Object.keys(envHttpHeaders).length
      ? [inlineTableLine("env_http_headers", envHttpHeaders)]
      : []),
  ].join("\n");

  if (!base.trim()) {
    return `${routingBlock}\n\n${tablesBlock}\n`;
  }

  const separator = base.endsWith("\n") ? "" : "\n";
  return `${routingBlock}\n\n${base}${separator}\n${tablesBlock}\n`;
}

/**
 * Insert or update root `model_catalog_json` after `model_provider` when missing.
 * @param {string} raw
 * @param {string} catalogPath
 */
export function patchCodexCatalogRefRaw(raw, catalogPath) {
  if (!catalogPath) {
    return ensureTrailingNewline(raw);
  }

  const hasCatalog = rootHasMatchingLine(raw, ROOT_MODEL_CATALOG_LINE);
  let inserted = false;

  return transformRootLines(raw, ({ trimmed }) => {
    if (hasCatalog && ROOT_MODEL_CATALOG_LINE.test(trimmed)) {
      return `model_catalog_json = "${catalogPath}"`;
    }
    return "keep";
  }, {
    afterRootLine: ({ trimmed, out }) => {
      if (!hasCatalog && !inserted && ROOT_MODEL_PROVIDER_LINE.test(trimmed)) {
        out.push(`model_catalog_json = "${catalogPath}"`);
        inserted = true;
      }
    },
  });
}

/**
 * @param {string} raw
 * @param {string} modelId
 */
export function patchCodexModelRaw(raw, modelId) {
  return transformRootLines(raw, ({ trimmed }) => {
    if (/^model\s*=/.test(trimmed)) {
      return `model = "${modelId}"`;
    }
    return "keep";
  });
}

/**
 * Rewrite the gateway provider's auth. With `chatgptLogin`, the key lives in
 * `http_headers`, so that line is rewritten from `httpHeaders` as well.
 * @param {string} raw
 * @param {{
 *   apiKey: string,
 *   literalAuth: boolean,
 *   chatgptLogin?: boolean,
 *   httpHeaders?: Record<string, string>,
 * }} auth
 */
export function patchCodexProviderAuthRaw(raw, {
  apiKey,
  literalAuth,
  chatgptLogin = false,
  httpHeaders = {},
}) {
  const lines = raw.split("\n");
  const out = [];
  let inProviderTable = false;
  let authPatched = false;
  const authLines = () => [
    ...providerAuthLines({ literal: literalAuth, apiKey, chatgptLogin }),
    ...(chatgptLogin && Object.keys(httpHeaders).length ? [httpHeadersLine(httpHeaders)] : []),
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === CODEX_PROVIDER_TABLE_HEADER) {
      inProviderTable = true;
      out.push(line);
      continue;
    }
    if (inProviderTable) {
      if (isAnyTableHeader(trimmed)) {
        if (!authPatched) {
          out.push(...authLines());
          authPatched = true;
        }
        inProviderTable = false;
        out.push(line);
        continue;
      }
      if (CODEX_BEARER_AUTH_LINE.test(trimmed)
        || CODEX_ENV_AUTH_LINE.test(trimmed)
        || /^requires_openai_auth\s*=/.test(trimmed)
        || (chatgptLogin && CODEX_HTTP_HEADERS_LINE.test(trimmed))) {
        continue;
      }
    }
    out.push(line);
  }

  if (inProviderTable && !authPatched) {
    out.push(...authLines());
  }

  return ensureTrailingNewline(out.join("\n"));
}
