import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { USER_SETTINGS_RELATIVE_PATH } from "../lib/harnesses/claude/core.mjs";
import { OPENCODE_CONFIG_RELATIVE_PATH } from "../lib/harnesses/opencode/core.mjs";
import { CODEX_CONFIG_RELATIVE_PATH } from "../lib/harnesses/codex/core.mjs";
import { buildServerlessCatalogSnapshot } from "../lib/fireworks/models.mjs";
import { HARNESSES, HARNESS_ALIASES } from "../lib/harness/id.mjs";
import {
  cacheServerlessCatalogSnapshot,
  readCatalogCache,
  setServerlessCatalogSnapshot,
} from "../lib/fireworks/serverless-catalog-cache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../bin/nexus.mjs");

process.env.NEXUS_SECRET_STORE ??= "memory";
process.env.NEXUS_TEST ??= "1";
process.env.NEXUS_TEST_CLAUDE_KEYCHAIN ??= "";
// Keep test catalog caches out of the developer's home.
process.env.NEXUS_CACHE_DIR ??= mkdtempSync(path.join(os.tmpdir(), "fc-cache-"));

/**
 * Persist a catalog snapshot for CLI children using this home.
 * @param {string} home
 * @param {object[]} apiModels flat serverless API rows
 */
export function seedServerlessCatalogCache(home, apiModels) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    if (readCatalogCache()?.snapshot) {
      return;
    }
    const snapshot = apiModels.length
      ? buildServerlessCatalogSnapshot(apiModels)
      : {
        entries: [],
        pricingById: new Map(),
        inputModalitiesById: new Map(),
        routerBaseModelById: new Map(),
        contextLengthById: new Map(),
        supportsToolsById: new Map(),
      };
    cacheServerlessCatalogSnapshot(snapshot);
  } finally {
    process.env.HOME = prevHome;
    // Avoid leaking the snapshot into unrelated tests.
    setServerlessCatalogSnapshot(null);
  }
}

/** Seed an empty cache unless the mock gateway serves this key's catalog. */
export function seedOnCommandCatalog(home, args = []) {
  const raw = Array.isArray(args) ? args.join(" ") : String(args ?? "");
  if (home && !/cataloged/i.test(raw)) {
    seedServerlessCatalogCache(home, []);
  }
}
// Tests pass a temp HOME and expect it to isolate Claude credentials. But
// claudeCredentialsPath() honors CLAUDE_CONFIG_DIR over home, so a dev
// machine running Claude Code under a custom config dir leaks real OAuth
// creds into the tests (e.g. "claude on --opus firerouter" succeeds when it should
// fail for lack of an Anthropic key). claudeCredentialsPath is the only
// reader of CLAUDE_CONFIG_DIR, so dropping it here is safe and makes the
// temp home authoritative.
delete process.env.CLAUDE_CONFIG_DIR;

// Attribution header value for the version under test. Read from package.json so
// a release bump can't strand these assertions on a stale literal.
export const FIRECONNECT_REFERER = `nexus/v${
  JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8")).version
}`;

export const FPK_KEY = "fpk_test_retired_key_000000000000";
export const FW_CLAUDE_KEY = "fw_test_claude_key_00000000000000";
export const FW_OPENCODE_KEY = "fw_test_opencode_key_00000000000";
export const FW_CODEX_KEY = "fw_test_codex_key_00000000000000";
export const SK_ANT_KEY = "sk-ant-test-non-fireworks-token";

export const NO_ENV_KEY = { FIREWORKS_API_KEY: "" };
export const TEST_SECRET_STORE_ENV = {
  NEXUS_SECRET_STORE: "memory",
  NEXUS_TEST: "1",
  NEXUS_TEST_CLAUDE_KEYCHAIN: "",
};

export async function withoutEnvFireworksKey(fn) {
  const prev = process.env.FIREWORKS_API_KEY;
  delete process.env.FIREWORKS_API_KEY;
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.FIREWORKS_API_KEY;
    } else {
      process.env.FIREWORKS_API_KEY = prev;
    }
  }
}

export const GLM_LATEST = "glm-latest";
export const GLM_FAST_LATEST = "glm-fast-latest";
export const GLM_5P2_FAST = "glm-5p2-fast";
export const KIMI_FAST_LATEST = "kimi-fast-latest";

/**
 * Flat `/v1/serverless/models` row: one (model, serverless_mode) pair. A
 * standard+fast pair for the same model needs two rows (see
 * mockServerlessModelRows). `aliases` carries the stable `-latest` router
 * resource names whose target is this model. `id` (or legacy `name`) sets the
 * model id; `display_name` (or legacy `displayName`) sets the label.
 */
export function defaultTestCatalogApiModels() {
  return [
    mockServerlessModel({
      name: "accounts/fireworks/models/glm-5p1",
      context_length: 1_048_576,
    }),
    mockServerlessModel({
      name: "accounts/fireworks/models/glm-5p2",
      context_length: 1_048_576,
      aliases: ["accounts/fireworks/routers/glm-fast-latest"],
    }),
    mockServerlessModel({
      name: "accounts/fireworks/models/kimi-k3",
      context_length: 1_048_576,
      aliases: [
        "accounts/fireworks/routers/kimi-fast-latest",
        "accounts/fireworks/routers/kimi-latest",
      ],
    }),
    mockServerlessModel({
      name: "accounts/fireworks/models/deepseek-v4-flash",
      context_length: 1_000_000,
    }),
    mockServerlessModel({
      name: "accounts/fireworks/models/old-model",
      context_length: 1_000_000,
    }),
  ];
}

/** Hydrate the in-process snapshot for unit tests that don't spawn the CLI. */
export function warmTestCatalogSnapshot() {
  setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(defaultTestCatalogApiModels()));
}

export function mockServerlessModel(overrides = {}) {
  const name = overrides.id ?? overrides.name ?? "accounts/fireworks/models/glm-5p2";
  const short = name.split("/").at(-1);
  return {
    id: name,
    display_name: overrides.display_name ?? overrides.displayName ?? "GLM 5.2",
    object: "model",
    serverless_mode: "standard",
    context_length: 1_048_576,
    input_modalities: ["text"],
    pricing: [
      { sku: "LLM input tokens (uncached)", amount: "1.4", unit: "1M tokens" },
      { sku: "LLM input tokens (cached)", amount: "0.14", unit: "1M tokens" },
      { sku: "LLM output tokens", amount: "4.4", unit: "1M tokens" },
    ],
    ...overrides,
    id: name, // last so a caller's explicit `id` can never be clobbered
  };
}

/** Standard + fast row pair for one model, mirroring the flat API's per-mode rows. */
export function mockServerlessModelRows(overrides = {}) {
  const name = overrides.id ?? overrides.name ?? "accounts/fireworks/models/glm-5p2";
  const short = name.split("/").at(-1);
  return [
    mockServerlessModel(overrides),
    mockServerlessModel({
      ...overrides,
      serverless_mode: "fast",
      usage_identifier: `accounts/fireworks/routers/${short}-fast`,
      pricing: [
        { sku: "LLM input tokens (uncached)", amount: "2.1", unit: "1M tokens" },
        { sku: "LLM input tokens (cached)", amount: "0.21", unit: "1M tokens" },
        { sku: "LLM output tokens", amount: "6.6", unit: "1M tokens" },
      ],
    }),
  ];
}
export const FIREWORKS_INFERENCE_URL = "https://api.fireworks.ai/inference";

export const HAS_SQLITE = spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0;
export const HAS_NPM = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8" }).status === 0;
export const itIfSqlite = HAS_SQLITE ? it : it.skip;
export const itIfNpm = HAS_NPM ? it : it.skip;

/** Expected OpenCode provider.models entry for a latest router alias. */
export function expectedOpencodeLatestRouterEntry(label, context = 1_048_575, output = 131_072) {
  return {
    name: label,
    limit: { context, output },
  };
}


export function claudePaths(home) {
  return {
    settingsPath: path.join(home, USER_SETTINGS_RELATIVE_PATH),
    dataDir: path.join(home, ".nexus/claude"),
  };
}

/** Assert Claude Code main default lives in top-level `model`, not env. */
export function assertClaudeMainModel(settings, expected, message = "") {
  const prefix = message ? `${message}: ` : "";
  assert.equal(settings.model, expected, `${prefix}top-level model`);
  assert.equal(settings.env?.ANTHROPIC_MODEL, undefined, `${prefix}ANTHROPIC_MODEL should be unset`);
}

const CLAUDE_SLOT_PIN_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

/** Nexus default: Anthropic tier slots stay native (no env pin). */
export function assertClaudeNativeTierSlots(settings, message = "") {
  const prefix = message ? `${message}: ` : "";
  for (const key of CLAUDE_SLOT_PIN_ENV_KEYS) {
    assert.equal(settings.env?.[key], undefined, `${prefix}${key}`);
    assert.equal(settings.env?.[`${key}_NAME`], undefined, `${prefix}${key}_NAME`);
  }
}

/** Registerable serverless models appear in Claude Code's settings.modelPicker. */
export function assertClaudeRegisterablePicker(settings, { includes = [], excludes = [] } = {}) {
  assert.equal(settings.modelPicker?.fireconnectManaged, true);
  assert.equal(settings.modelPicker?.replaceBuiltInOptions, false);
  const models = settings.modelPicker?.options?.map((row) => row.model) ?? [];
  for (const id of includes) {
    assert.ok(models.includes(id), `picker missing ${id}: ${models.join(", ")}`);
  }
  for (const id of excludes) {
    assert.ok(!models.includes(id), `picker should not include ${id}: ${models.join(", ")}`);
  }
  return models;
}

export async function withTempHome(prefix, fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), `fireconnect-${prefix}-`));
  try {
    return await fn(home);
  } finally {
    await removeTempDir(home);
  }
}

/**
 * Run a test callback with Linux SSH env markers set (no-op on other platforms).
 *
 * @template T
 * @param {(platformIsLinux: boolean) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLinuxSshEnv(fn) {
  if (process.platform !== "linux") {
    return fn(false);
  }
  const prev = {
    SSH_CONNECTION: process.env.SSH_CONNECTION,
    NEXUS_KEY_STORAGE: process.env.NEXUS_KEY_STORAGE,
  };
  process.env.SSH_CONNECTION = "203.0.113.1 12345 198.51.100.2 22";
  delete process.env.NEXUS_KEY_STORAGE;
  try {
    return await fn(true);
  } finally {
    if (prev.SSH_CONNECTION === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = prev.SSH_CONNECTION;
    if (prev.NEXUS_KEY_STORAGE === undefined) delete process.env.NEXUS_KEY_STORAGE;
    else process.env.NEXUS_KEY_STORAGE = prev.NEXUS_KEY_STORAGE;
  }
}

/**
 * Remove a temp dir, tolerating a transient ENOTEMPTY/EBUSY from a just-exited
 * subprocess still flushing files. Cleanup must never fail a test whose
 * assertions already passed — the OS reaps leftover temp dirs regardless.
 * @param {string} dir
 */
async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EBUSY") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

/**
 * Codex `on`/`off` block while the ChatGPT app is running (mirrors
 * Cursor/VS Code). Tests spawn non-TTY children, so the guard would throw
 * "ChatGPT app is running" whenever the app is open on the dev machine.
 * Append `--force` to bypass it, the way Cursor/VS Code tests pass `--force`
 * per call. Shared so the bypass lives in one place.
 */
export function codexOnOffArgs(args) {
  return args[0] === "codex" && (args[1] === "on" || args[1] === "off") && !args.includes("--force")
    ? [...args, "--force"]
    : args;
}

/**
 * HOME for a spawned CLI child. A child that inherits the developer's HOME
 * runs the rename migration and launcher rewrite against their real install,
 * so a call that names no HOME gets a throwaway one instead.
 * @param {Record<string, string | undefined>} env
 */
export function isolatedChildHome(env = {}) {
  return env.HOME ?? mkdtempSync(path.join(os.tmpdir(), "fc-run-home-"));
}

const HARNESS_TOKENS = new Set([...HARNESSES, ...Object.keys(HARNESS_ALIASES)]);

/**
 * `on` refuses a harness with no install footprint, and test homes start
 * empty. Append `--skip-install-check` to harness commands so specs exercise
 * the config rewrite; the gate's own specs pass `installGate: true`.
 */
export function harnessTestArgs(args, { installGate = false } = {}) {
  const withCodex = codexOnOffArgs(args);
  return !installGate && withCodex.some((arg) => HARNESS_TOKENS.has(arg)) && !withCodex.includes("--skip-install-check")
    ? [...withCodex, "--skip-install-check"]
    : withCodex;
}

export function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    if (args.includes("on")) {
      seedOnCommandCatalog(env.HOME, args);
    }
    const child = spawn(process.execPath, [CLI, ...harnessTestArgs(args)], {
      env: {
        ...process.env,
        ...TEST_SECRET_STORE_ENV,
        ...env,
        HOME: isolatedChildHome(env),
        NEXUS_SECRET_STORE: "memory",
        NEXUS_TEST: "1",
        FIREWORKS_API_KEY: env.FIREWORKS_API_KEY ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export async function seedKeychainConfig(home, apiKey) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // The in-memory secret store keeps module-global backend state; reset it so
    // this seed initializes for THIS home (otherwise a prior seed's home stays
    // pinned in-process and this key lands in the wrong sandbox's store).
    const { resetSecretStoreForTests } = await import("../lib/keys/secret-store.mjs");
    resetSecretStoreForTests();
    const { persistApiKeyToKeychain } = await import("../lib/keys/api-key.mjs");
    await persistApiKeyToKeychain(home, apiKey);
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  }
}

export async function runCli(args, { home, env = {}, installGate = false } = {}) {
  return new Promise((resolve, reject) => {
    if (args.includes("on")) {
      seedOnCommandCatalog(home, args);
    }
    const child = spawn(process.execPath, [CLI, ...harnessTestArgs(args, { installGate })], {
      env: {
        ...process.env,
        ...TEST_SECRET_STORE_ENV,
        ...env,
        HOME: home,
        NEXUS_SECRET_STORE: "memory",
        NEXUS_TEST: "1",
        FIREWORKS_API_KEY: env.FIREWORKS_API_KEY ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export async function runCliJson(args, options) {
  const result = await runCli(args, options);
  return {
    ...result,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

export async function writeClaudeSettings(home, apiKey, { fireworks = true } = {}) {
  const settingsPath = path.join(home, USER_SETTINGS_RELATIVE_PATH);
  const env = fireworks
    ? { ANTHROPIC_BASE_URL: FIREWORKS_INFERENCE_URL, ANTHROPIC_API_KEY: apiKey }
    : { ANTHROPIC_API_KEY: apiKey };
  await writeJson(settingsPath, { env });
  return settingsPath;
}

export async function writeNativeAnthropicSettings(home) {
  return writeClaudeSettings(home, SK_ANT_KEY, { fireworks: false });
}

export async function writeOpencodeConfig(home, apiKey) {
  const configPath = path.join(home, OPENCODE_CONFIG_RELATIVE_PATH);
  await writeJson(configPath, {
    provider: {
      "fireworks-ai": { options: { apiKey } },
    },
    model: `fireworks-ai/accounts/fireworks/routers/${GLM_LATEST}`,
  });
  return configPath;
}

export async function writeCodexConfig(home, { apiKey = FW_CODEX_KEY, envRef = false } = {}) {
  const configPath = path.join(home, CODEX_CONFIG_RELATIVE_PATH);
  const authLines = envRef
    ? ['env_key = "FIREWORKS_API_KEY"']
    : [`experimental_bearer_token = "${apiKey}"`];
  const toml = [
    'model_provider = "fireworks-ai"',
    `model = "accounts/fireworks/routers/${KIMI_FAST_LATEST}"`,
    "",
    "[model_providers.fireworks-ai]",
    'name = "Fireworks"',
    'base_url = "https://api.fireworks.ai/inference/v1"',
    'wire_api = "responses"',
    ...authLines,
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, toml);
  return configPath;
}

export async function readClaudeSettings(home) {
  return JSON.parse(await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8"));
}

export async function readOpencodeConfig(home) {
  return JSON.parse(await readFile(path.join(home, OPENCODE_CONFIG_RELATIVE_PATH), "utf8"));
}
