export const DEEPSEEK_HOME_RELATIVE_DIR = ".dsh";
export const DEEPSEEK_DATA_RELATIVE_DIR = ".nexus/deepseek";

/** Provider route id under `llm-pi-ai.providers`. */
export const DEEPSEEK_FIREWORKS_PROVIDER_ID = "fireworks";
/** OpenAI-compatible Fireworks inference base (includes `/v1`). */
export const DEEPSEEK_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const DEEPSEEK_API_KEY_ENV = "FIREWORKS_API_KEY";

export const DEEPSEEK_LLM_PI_AI_NS = "llm-pi-ai";
export const DEEPSEEK_DEFAULT_MODEL_NS = "agent-default-model";

/** Per-profile config root under `$DSH_HOME` (dsh 0.1.7+ profile model). */
export const DEEPSEEK_PROFILES_DIRNAME = "profiles";
/** Profile root marker dsh writes when it initializes a profile. */
export const DEEPSEEK_PROFILE_ROOT_FILENAME = "cordis.yml";
/** User patch layer inside each profile dir — dsh 0.1.7+ composes this after
 * bundle layers, so it is the only persistent write target once
 * `settings.yaml` became a legacy import-only document. */
export const DEEPSEEK_PROFILE_PATCH_FILENAME = "cordis.patch.yml";
/** Loader entry ids/plugins the patch uses (mirror what dsh's own
 * legacy-settings import writes). */
export const DEEPSEEK_LLM_PI_AI_ENTRY_ID = "llm-pi-ai";
export const DEEPSEEK_LLM_PI_AI_PLUGIN = "@deepseek-ai/dsh-llm-pi-ai";
export const DEEPSEEK_AGENT_DEFAULT_MODEL_ENTRY_ID = "agent-default-model";
export const DEEPSEEK_AGENT_DEFAULT_MODEL_PLUGIN = "@deepseek-ai/dsh-agent-default-model";
