import { readJsonIfExists, writeJson } from "../io/json.mjs";
import { reconcileShellEnvHook } from "../io/shell-env-hook.mjs";
import { HARNESS } from "../harness/id.mjs";
import {
  WEBSEARCH_MCP_SERVER_NAME,
  claudeJsonPath,
  hasManagedWebsearchMcp,
} from "./websearch-state.mjs";

export {
  WEBSEARCH_MCP_SERVER_NAME,
  WEBSEARCH_MCP_URL,
  claudeJsonPath,
  hasManagedWebsearchMcp,
} from "./websearch-state.mjs";

/**
 * @param {unknown} config
 * @returns {{ config: object, changed: boolean }}
 */
function withoutManagedWebsearchMcp(config) {
  const current = config ?? {};
  const servers = { ...(current.mcpServers ?? {}) };
  if (!Object.hasOwn(servers, WEBSEARCH_MCP_SERVER_NAME)) {
    return { config: current, changed: false };
  }
  delete servers[WEBSEARCH_MCP_SERVER_NAME];
  const next = { ...current };
  if (Object.keys(servers).length > 0) {
    next.mcpServers = servers;
  } else {
    delete next.mcpServers;
  }
  return { config: next, changed: true };
}

/**
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
async function disableWebsearchMcpForHarness(home, harnessId) {
  if (harnessId !== HARNESS.CLAUDE) {
    throw new Error(`Websearch MCP removal is not supported for harness: ${harnessId}`);
  }
  const filePath = claudeJsonPath(home);
  const current = await readJsonIfExists(filePath) ?? {};
  const { config: next, changed } = withoutManagedWebsearchMcp(current);
  if (!changed) {
    return { changed: false, filePath };
  }
  await writeJson(filePath, next);
  return { changed: true, filePath };
}

/**
 * Remove the retired Nexus-managed `fireworks-websearch` MCP entry.
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} [harnessId]
 */
export async function disableWebsearchMcp(home, harnessId = HARNESS.CLAUDE) {
  const result = await disableWebsearchMcpForHarness(home, harnessId);
  await reconcileShellEnvHook(home);
  return result;
}
