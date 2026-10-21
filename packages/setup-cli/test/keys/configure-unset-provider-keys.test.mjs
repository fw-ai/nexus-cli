import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { runCli, withTempHome } from "../helpers.mjs";
import { readGlobalConfig } from "../../lib/config/global-config.mjs";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import { opencodeConfigPath, OPENCODE_FIREWORKS_PROVIDER_ID } from "../../lib/harnesses/opencode/core.mjs";
import { piAuthPath, piModelsPath } from "../../lib/harnesses/pi/core.mjs";

const FIREWORKS_KEY = "fw_test_key_12345";
const ANTHROPIC_KEY = "sk-ant-unset-test-00000000";
const OPENAI_KEY = "sk-proj-unset-test-00000000";

const HARNESSES = ["claude", "opencode", "pi", "vscode"];

// Pi keeps the Fireworks key in auth.json and VS Code in its secret store;
// the provider keys live in the files below.
function fireworksKeyFile(home, harness, files) {
  return { pi: piAuthPath(home), vscode: "" }[harness] ?? files[harness];
}

function harnessFiles(home) {
  return {
    claude: userSettingsPath(home),
    opencode: opencodeConfigPath(home),
    pi: piModelsPath(home),
    vscode: path.join(home, ".config/Code/User/chatLanguageModels.json"),
  };
}

/**
 * Write a saved provider key into a harness config the way an earlier
 * release's FireRouter `on` baked it in, so `configure --unset` has a copy
 * to remove from every harness.
 */
async function injectSavedKey(file, harness, headerName, key) {
  const raw = JSON.parse(await readFile(file, "utf8"));
  if (harness === "claude") {
    raw.env.ANTHROPIC_CUSTOM_HEADERS = `${raw.env.ANTHROPIC_CUSTOM_HEADERS}\n${headerName}: ${key}`;
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
    return;
  }
  if (harness === "opencode") {
    const options = raw.provider[OPENCODE_FIREWORKS_PROVIDER_ID].options;
    options.headers = { ...(options.headers ?? {}), [headerName]: key };
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
    return;
  }
  if (harness === "pi") {
    const provider = raw.providers.fireworks;
    provider.headers = { ...(provider.headers ?? {}), [headerName]: key };
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
    return;
  }
  const provider = raw.find((entry) => Array.isArray(entry?.models));
  for (const model of provider.models) {
    model.requestHeaders = { ...(model.requestHeaders ?? {}), [headerName]: key };
    if (headerName === "x-anthropic-api-key") {
      model.anthropic_api_key = key;
    }
  }
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
}

async function withHarnessHome(prefix, fn) {
  await withTempHome(prefix, async (home) => {
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = {
      FIREWORKS_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      XDG_CONFIG_HOME: path.join(home, ".config"),
      NEXUS_VSCODE_SECRET_PLAINTEXT: "1",
    };
    const on = async (harness) => {
      const result = await runCli(
        [harness, "on", "--api-key", FIREWORKS_KEY, ...(harness === "vscode" ? ["--force"] : [])],
        { home, env },
      );
      assert.equal(result.code, 0, `${harness}: ${result.stderr}`);
    };
    await fn({ home, env, on, files: harnessFiles(home) });
  });
}

describe("configure --unset openai-api-key / --unset anthropic-api-key across harnesses", () => {
  it("removes the saved OpenAI key from every harness, and a repeat on doesn't bring it back", async () => {
    await withHarnessHome("unset-openai-harnesses-", async ({ home, env, on, files }) => {
      const configure = await runCli(["configure", "--openai-api-key", OPENAI_KEY], { home, env });
      assert.equal(configure.code, 0, configure.stderr);
      for (const harness of HARNESSES) {
        await on(harness);
        await injectSavedKey(files[harness], harness, "x-openai-api-key", OPENAI_KEY);
        assert.match(await readFile(files[harness], "utf8"), new RegExp(OPENAI_KEY), harness);
      }

      const unset = await runCli(["configure", "--unset", "openai-api-key"], { home, env });
      assert.equal(unset.code, 0, unset.stderr);
      assert.match(unset.stdout, /Removed the saved OpenAI key\./);
      assert.match(unset.stdout, /Removed the saved OpenAI key from Claude Code, OpenCode, Pi and VS Code\. Restart them/);
      assert.equal((await readGlobalConfig(home)).openaiApiKey, "");

      const assertGone = async (when) => {
        for (const harness of HARNESSES) {
          const raw = await readFile(files[harness], "utf8");
          assert.doesNotMatch(raw, new RegExp(OPENAI_KEY), `${harness} ${when}`);
          const fireworksFile = fireworksKeyFile(home, harness, files);
          if (fireworksFile) {
            assert.match(await readFile(fireworksFile, "utf8"), new RegExp(FIREWORKS_KEY), `${harness} keeps the Fireworks key ${when}`);
          }
        }
      };
      await assertGone("after unset");
      for (const harness of HARNESSES) {
        await on(harness);
      }
      await assertGone("after a repeat on");

      const again = await runCli(["configure", "--unset", "openai-api-key"], { home, env });
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /No saved OpenAI key to remove/);
      assert.doesNotMatch(again.stdout, /Removed the saved/);
    });
  });

  it("removes the saved Anthropic key from every harness but leaves Claude Code's own sign-in", async () => {
    await withHarnessHome("unset-anthropic-harnesses-", async ({ home, env, on, files }) => {
      // Claude Code's own sign-in: a key the user set before Nexus.
      await mkdir(path.dirname(files.claude), { recursive: true });
      await writeFile(files.claude, JSON.stringify({ env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } }));
      const configure = await runCli(["configure", "--anthropic-api-key", ANTHROPIC_KEY], { home, env });
      assert.equal(configure.code, 0, configure.stderr);
      await on("claude");
      for (const harness of ["opencode", "pi", "vscode"]) {
        await on(harness);
        await injectSavedKey(files[harness], harness, "x-anthropic-api-key", ANTHROPIC_KEY);
        assert.match(await readFile(files[harness], "utf8"), new RegExp(ANTHROPIC_KEY), harness);
      }

      const unset = await runCli(["configure", "--unset", "anthropic-api-key"], { home, env });
      assert.equal(unset.code, 0, unset.stderr);
      assert.match(unset.stdout, /Removed the saved Anthropic key from OpenCode, Pi and VS Code\./);
      assert.match(unset.stdout, /Claude Code still signs in with the Anthropic key in its own settings/);
      assert.equal((await readGlobalConfig(home)).anthropicApiKey, "");

      const assertGone = async (when) => {
        for (const harness of ["opencode", "pi", "vscode"]) {
          const raw = await readFile(files[harness], "utf8");
          assert.doesNotMatch(raw, new RegExp(ANTHROPIC_KEY), `${harness} ${when}`);
          assert.doesNotMatch(raw, /x-anthropic-api-key|anthropic_api_key/i, `${harness} ${when}`);
          const fireworksFile = fireworksKeyFile(home, harness, files);
          if (fireworksFile) {
            assert.match(await readFile(fireworksFile, "utf8"), new RegExp(FIREWORKS_KEY), `${harness} keeps the Fireworks key ${when}`);
          }
        }
      };
      await assertGone("after unset");
      for (const harness of ["opencode", "pi", "vscode"]) {
        await on(harness);
      }
      await assertGone("after a repeat on");
      const claude = JSON.parse(await readFile(files.claude, "utf8"));
      assert.equal(claude.env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);
    });
  });
});
