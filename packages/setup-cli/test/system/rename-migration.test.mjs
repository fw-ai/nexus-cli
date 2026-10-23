import assert from "node:assert/strict";
import { access, lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { disableFireworksProvider, stripLegacyAttributionHeaderLeftover } from "../../lib/harnesses/claude/core.mjs";
import { claudeStatusLineCommand } from "../../lib/harnesses/claude/statusline.mjs";
import {
  copilotDataDbPath,
  findFireconnectProvider,
  upsertFireconnectProvider,
} from "../../lib/harnesses/copilot-app/sqlite.mjs";
import { RENAME_KEY_MESSAGE, renameHeadline } from "../../lib/system/data-dir.mjs";

const RENAME_HEADLINE = renameHeadline();
import { runRenameMigration } from "../../lib/system/rename-migration.mjs";
import { telemetryReferer } from "../../lib/telemetry/request-headers.mjs";
import { itIfSqlite, runFireconnect, withTempHome } from "../helpers.mjs";

async function exists(file) {
  return access(file).then(() => true, () => false);
}

describe("runRenameMigration", () => {
  it("moves the data directory and repoints everything that referenced it", async () => {
    await withTempHome("rename-migration-", async (home) => {
      await mkdir(path.join(home, ".fireconnect/cli/packages/setup-cli/bin"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/cli/packages/setup-cli/bin/nexus.mjs"), "");
      await mkdir(path.join(home, ".local/bin"), { recursive: true });
      await writeFile(
        path.join(home, ".local/bin/fireconnect"),
        `exec node "${home}/.fireconnect/cli/packages/setup-cli/bin/fireconnect.mjs" "$@"\n`,
      );
      await writeFile(path.join(home, ".bashrc"), "# >>> fireconnect >>>\nexport X=1\n# <<< fireconnect <<<\n");
      await mkdir(path.join(home, ".claude"), { recursive: true });
      await writeFile(path.join(home, ".claude/settings.json"), JSON.stringify({
        statusLine: { type: "command", command: `node ${home}/.fireconnect/cli/packages/setup-cli/bin/claude-statusline.mjs` },
      }));

      await mkdir(path.join(home, ".config/opencode"), { recursive: true });
      await writeFile(path.join(home, ".config/opencode/opencode.json"), JSON.stringify({
        provider: { "fireworks-ai": { options: { headers: { "X-Title": "OpenCode", "HTTP-Referer": "fireconnect/v0.9.9" } } } },
      }));

      const notes = await runRenameMigration(home);

      assert.deepEqual(notes, [
        "Moved ~/.fireconnect to ~/.nexus.",
        "Replaced the `fireconnect` command with `nexus`.",
        "Removed the old fireconnect shell hook from your shell profile. Open a new terminal to pick up the change.",
        "Pointed Claude Code's status line at ~/.nexus.",
        "Updated your harness configs to identify as Nexus CLI — restart them to pick it up.",
      ]);
      const opencode = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
      assert.equal(opencode.provider["fireworks-ai"].options.headers["HTTP-Referer"], telemetryReferer());
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");
      assert.equal(await exists(path.join(home, ".local/bin/fireconnect")), false);
      assert.match(await readFile(path.join(home, ".local/bin/nexus"), "utf8"), /\.nexus\/cli\/packages\/setup-cli\/bin\/nexus\.mjs/);
      assert.doesNotMatch(await readFile(path.join(home, ".bashrc"), "utf8"), /fireconnect/);
      const settings = JSON.parse(await readFile(path.join(home, ".claude/settings.json"), "utf8"));
      assert.equal(settings.statusLine.command, claudeStatusLineCommand());
      assert.deepEqual(await runRenameMigration(home), [], "idempotent");
    });
  });

  it("repoints a v0.8-era apiKeyHelper at the nexus launcher, and leaves a user's own alone", async () => {
    await withTempHome("rename-migration-helper-", async (home) => {
      await mkdir(path.join(home, ".claude"), { recursive: true });
      const settingsPath = path.join(home, ".claude/settings.json");
      await writeFile(settingsPath, JSON.stringify({
        apiKeyHelper: `${home}/.local/bin/fireconnect --home ${home} key export --stored-only`,
      }));

      const notes = await runRenameMigration(home);
      assert.ok(notes.includes("Pointed Claude Code's API key helper at the `nexus` command."));
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.apiKeyHelper, `${home}/.local/bin/nexus --home ${home} key export --stored-only`);
      assert.deepEqual(await runRenameMigration(home), [], "idempotent");

      const own = "/usr/local/bin/fireconnect-vault get key";
      await writeFile(settingsPath, JSON.stringify({ apiKeyHelper: own }));
      await runRenameMigration(home);
      assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).apiKeyHelper, own);
    });
  });

  it("removes the 0.7/0.8 attribution-header leftover so a later off can't put it back", async () => {
    await withTempHome("rename-migration-attribution-", async (home) => {
      const settingsPath = path.join(home, ".claude/settings.json");
      const backupPath = path.join(home, ".nexus/claude/provider-backup.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await mkdir(path.dirname(backupPath), { recursive: true });
      const leftover = { theme: "dark", env: { MY_VAR: "keep-me", CLAUDE_CODE_ATTRIBUTION_HEADER: "0" } };
      await writeFile(settingsPath, JSON.stringify(leftover));
      await writeFile(backupPath, JSON.stringify({
        configPath: settingsPath,
        snapshot: { existed: true, raw: JSON.stringify(leftover) },
      }));

      await runRenameMigration(home);

      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { theme: "dark", env: { MY_VAR: "keep-me" } });
      await disableFireworksProvider({ settingsPath, dataDir: path.join(home, ".nexus/claude") });
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { theme: "dark", env: { MY_VAR: "keep-me" } });
    });
  });

  it("keeps a user's own attribution-header value and only-header env", async () => {
    await withTempHome("rename-migration-attribution-own-", async (home) => {
      const settingsPath = path.join(home, ".claude/settings.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_ATTRIBUTION_HEADER: "1" } }));
      await runRenameMigration(home);
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { env: { CLAUDE_CODE_ATTRIBUTION_HEADER: "1" } });

      await writeFile(settingsPath, JSON.stringify({ theme: "dark", env: { CLAUDE_CODE_ATTRIBUTION_HEADER: "0" } }));
      await runRenameMigration(home);
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { theme: "dark" });
    });
  });

  it("drops the leftover from a legacy values-only backup so off removes it", () => {
    const { settings, backup } = stripLegacyAttributionHeaderLeftover(
      {},
      { values: { CLAUDE_CODE_ATTRIBUTION_HEADER: "0", MY_VAR: "x" }, missing: ["ANTHROPIC_BASE_URL"] },
    );
    assert.equal(settings, null);
    assert.deepEqual(backup, { values: { MY_VAR: "x" }, missing: ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ATTRIBUTION_HEADER"] });
    assert.deepEqual(stripLegacyAttributionHeaderLeftover({ env: {} }, {}), { settings: null, backup: null });
  });

  itIfSqlite("retargets the Copilot app's provider row without a re-`on`", async () => {
    await withTempHome("rename-migration-copilot-app-", async (home) => {
      const dbPath = copilotDataDbPath({ home });
      await upsertFireconnectProvider(dbPath, {
        providerId: "fc-test-provider",
        apiKey: "fw-test-key",
        models: [{ id: "accounts/example-account/models/test-model", displayName: "Test model" }],
        extraHeaders: { "HTTP-Referer": "fireconnect/v0.9.9", "X-Title": "Copilot" },
      });

      const notes = await runRenameMigration(home, { isCopilotAppRunning: () => false });

      assert.deepEqual(notes, ["Updated your harness configs to identify as Nexus CLI — restart them to pick it up."]);
      const provider = await findFireconnectProvider(dbPath);
      const headers = JSON.parse(JSON.parse(provider.settings_json).headersJson);
      assert.deepEqual(headers, {
        Authorization: "Bearer fw-test-key",
        "HTTP-Referer": telemetryReferer(),
        "X-Title": "Copilot",
      });
      assert.deepEqual(await runRenameMigration(home, { isCopilotAppRunning: () => false }), [], "idempotent");
    });
  });

  itIfSqlite("leaves the Copilot app's row alone while the app is open, and says so", async () => {
    await withTempHome("rename-migration-copilot-app-open-", async (home) => {
      const dbPath = copilotDataDbPath({ home });
      await upsertFireconnectProvider(dbPath, {
        providerId: "fc-test-provider",
        apiKey: "fw-test-key",
        models: [{ id: "accounts/example-account/models/test-model", displayName: "Test model" }],
        extraHeaders: { "HTTP-Referer": "fireconnect/v0.9.9" },
      });
      const before = (await findFireconnectProvider(dbPath)).settings_json;

      const notes = await runRenameMigration(home, { isCopilotAppRunning: () => true });

      assert.deepEqual(notes, ["Quit GitHub Copilot and run `nexus copilot-app on` once so it identifies as Nexus CLI too."]);
      assert.equal((await findFireconnectProvider(dbPath)).settings_json, before);
    });
  });

  it("stops at a foreign ~/.nexus without repointing anything or marking completion", async () => {
    await withTempHome("rename-migration-foreign-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await writeFile(path.join(home, ".nexus/settings.ini"), "other=1\n");
      await mkdir(path.join(home, ".local/bin"), { recursive: true });
      await writeFile(
        path.join(home, ".local/bin/fireconnect"),
        `exec node "${home}/.fireconnect/cli/packages/setup-cli/bin/fireconnect.mjs" "$@"\n`,
      );

      const notes = await runRenameMigration(home);

      assert.deepEqual(notes, [
        "~/.nexus belongs to another program, so your FireConnect settings stay in ~/.fireconnect. "
        + "Rename or remove ~/.nexus, then upgrade again.",
      ]);
      assert.deepEqual(await readdir(path.join(home, ".nexus")), ["settings.ini"], "no marker written into the other program's directory");
      assert.equal(await exists(path.join(home, ".local/bin/nexus")), false, "launcher not replaced");
      assert.equal(await exists(path.join(home, ".local/bin/fireconnect")), true);
      assert.ok((await lstat(path.join(home, ".fireconnect"))).isDirectory(), "legacy data stays put");

      // And again: the foreign directory must not be misrecognized as ours
      // on a later run (the completion marker used to flip that check).
      assert.deepEqual(await runRenameMigration(home), notes);
      assert.deepEqual(await readdir(path.join(home, ".nexus")), ["settings.ini"]);
    });
  });

  it("lets finalize-install and update report the block instead of dead-ending on it", async () => {
    await withTempHome("rename-migration-foreign-cli-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await writeFile(path.join(home, ".nexus/settings.ini"), "other=1\n");

      const finalize = await runFireconnect(["finalize-install"], { HOME: home });
      assert.equal(finalize.code, 1);
      assert.match(finalize.stderr, /~\/\.nexus belongs to another program/);
      assert.match(finalize.stderr, /Finalize stopped: rename or remove ~\/\.nexus/);
      assert.doesNotMatch(finalize.stderr, /Command failed/);

      const update = await runFireconnect(["update"], { HOME: home });
      assert.equal(update.code, 1);
      assert.match(update.stderr, /Update stopped before changing anything/);
      assert.doesNotMatch(update.stderr, /Command failed/);

      assert.deepEqual(await readdir(path.join(home, ".nexus")), ["settings.ini"]);
    });
  });

  it("tells the user about an existing ~/.nexus once per finalize", async () => {
    await withTempHome("rename-migration-set-aside-once-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await writeFile(path.join(home, ".nexus/config.json"), `${JSON.stringify({ harnesses: {} })}\n`);

      const result = await runFireconnect(["finalize-install"], { HOME: home });

      const output = result.stdout + result.stderr;
      assert.equal(output.match(/~\/\.nexus already existed/g)?.length, 1, output);
    });
  });

  it("finishes the rename on the first command when finalize never ran", async () => {
    await withTempHome("rename-migration-first-command-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      await mkdir(path.join(home, ".local/bin"), { recursive: true });
      await writeFile(
        path.join(home, ".local/bin/fireconnect"),
        `exec node "${home}/.fireconnect/cli/packages/setup-cli/bin/fireconnect.mjs" "$@"\n`,
      );

      const result = await runFireconnect(["status"], { HOME: home });

      assert.match(result.stderr, /FireConnect is now Nexus CLI\. Use `nexus` from now on\.\nYour harnesses, key, and settings carry over unchanged\.\nFireRouter is now Nexus Auto: use the `auto` model\./);
      assert.match(result.stderr, /Replaced the `fireconnect` command with `nexus`\./);
      assert.equal(await exists(path.join(home, ".local/bin/fireconnect")), false);
      assert.equal(await exists(path.join(home, ".local/bin/nexus")), true);
      assert.equal(await readlink(path.join(home, ".fireconnect")), ".nexus");

      const again = await runFireconnect(["status"], { HOME: home });
      assert.doesNotMatch(again.stderr, /FireConnect is now Nexus/);
    });
  });

  it("paints the key message primary and the command accent when color is on", async () => {
    await withTempHome("rename-migration-heading-color-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      await mkdir(path.join(home, ".local/bin"), { recursive: true });
      await writeFile(
        path.join(home, ".local/bin/fireconnect"),
        `exec node "${home}/.fireconnect/cli/packages/setup-cli/bin/fireconnect.mjs" "$@"\n`,
      );

      const result = await runFireconnect(["status"], { HOME: home, FORCE_COLOR: "1", NEXUS_THEME: "dark" });

      assert.ok(
        result.stderr.includes(`\u001b[38;2;252;114;147m${RENAME_KEY_MESSAGE}\u001b[39m Use \u001b[38;2;240;172;214mnexus\u001b[39m from now on.\n`),
        result.stderr,
      );
    });
  });

  it("uses the light-theme colors for the rename headline when NEXUS_THEME=light", async () => {
    await withTempHome("rename-migration-heading-light-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");

      const result = await runFireconnect(["status"], { HOME: home, FORCE_COLOR: "1", NEXUS_THEME: "light" });

      assert.ok(
        result.stderr.includes(`\u001b[38;2;191;17;83m${RENAME_KEY_MESSAGE}\u001b[39m Use \u001b[38;2;167;30;126mnexus\u001b[39m from now on.\n`),
        result.stderr,
      );
    });
  });

  it("announces the rename during an older upgrader's finalize-install, then never again", async () => {
    await withTempHome("rename-migration-headline-finalize-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await writeFile(path.join(home, ".fireconnect/config.json"), "{}\n");
      await mkdir(path.join(home, ".local/bin"), { recursive: true });
      await writeFile(
        path.join(home, ".local/bin/fireconnect"),
        `exec node "${home}/.fireconnect/cli/packages/setup-cli/bin/fireconnect.mjs" "$@"\n`,
      );

      const result = await runFireconnect(["finalize-install"], { HOME: home });

      const output = result.stdout + result.stderr;
      assert.equal(output.split(RENAME_HEADLINE).length - 1, 1, output);
      assert.ok(output.indexOf(RENAME_HEADLINE) < output.indexOf("Moved ~/.fireconnect to ~/.nexus."), output);
      assert.match(output, /Replaced the `fireconnect` command with `nexus`\./);

      const again = await runFireconnect(["status"], { HOME: home });
      assert.ok(!again.stderr.includes(RENAME_HEADLINE), again.stderr);
    });
  });

  it("announces the rename when the installer already moved ~/.fireconnect", async () => {
    await withTempHome("rename-migration-headline-installer-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await writeFile(path.join(home, ".nexus/config.json"), "{}\n");
      await symlink(".nexus", path.join(home, ".fireconnect"));

      const result = await runFireconnect(["finalize-install"], { HOME: home });

      assert.ok((result.stdout + result.stderr).includes(RENAME_HEADLINE), result.stdout + result.stderr);
    });
  });

  it("never announces the rename on a fresh Nexus CLI install", async () => {
    await withTempHome("rename-migration-headline-fresh-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await writeFile(path.join(home, ".nexus/config.json"), "{}\n");

      const result = await runFireconnect(["finalize-install"], { HOME: home });

      assert.ok(!(result.stdout + result.stderr).includes("FireConnect"), result.stdout + result.stderr);
    });
  });
});
