# Nexus

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/fw-ai/nexus-cli/blob/main/LICENSE)

> Use [Fireworks AI](https://fireworks.ai) models inside the coding harnesses you already use: Claude Code, Claude Desktop, OpenCode, Codex, Pi, Cursor, VS Code, GitHub Copilot (app and CLI), and DeepSeek Harness.

Nexus is a small CLI that points each harness at Fireworks by editing that harness's own
settings. No hosted service, nothing extra to run:

- **`nexus <harness>`** routes it through Fireworks and registers Fireworks models in its picker.
- **`nexus <harness> off`** puts your original settings back **exactly as they were**, byte for byte.
- One Fireworks key is stored once (OS keychain where available) and shared by every harness you connect.

**Contents:** [Quick start](#quick-start) · [Supported harnesses](#supported-harnesses) ·
[Default models](#default-models) · [Claude Code](#claude-code) · [Codex](#codex) ·
[OpenCode](#opencode) · [Pi](#pi) · [Cursor](#cursor) · [VS Code Chat](#vs-code-chat) ·
[GitHub Copilot app](#github-copilot-app) · [GitHub Copilot CLI](#github-copilot-cli) · [DeepSeek Harness](#deepseek-harness) ·
[Claude Desktop](#claude-desktop) · [FireRouter](#firerouter) · [Models](#models) ·
[Azure / Foundry](#azure-microsoft-foundry-endpoints) · [CLI reference](#cli-reference) ·
[Keys and storage](#keys-and-storage) · [Troubleshooting](#troubleshooting) ·
[Upgrade and uninstall](#upgrade-and-uninstall)

## Quick start

**1. Install**

```bash
curl -fsSL https://nexus.fireworks.ai/install.sh | bash
```

Or install direct from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/fw-ai/nexus-cli/main/install.sh | bash
```

**2. Sign in**

```bash
nexus login        # browser sign-in, or paste a fw_… key
```

**3. Connect a harness**

```bash
nexus claude       # routes through Fireworks, appends the catalog to /model
```

```text
✓ Claude Code → Fireworks · auto
Model picker
  Anthropic model slots → unchanged
  Fireworks catalog → appended in /model

Also in your model list: …

Restart Claude Code to use the new setup.

Manage models
  Browse       nexus model list
  Choose model nexus claude --model <id>
```

**4. Restart the harness, then check**

```bash
nexus claude status
```

```text
Claude Code
Connection: on
Provider: Fireworks
Auth: X-Fireworks-Api-Key header in settings.json
Model: auto

Registered models:
  auto
  deepseek-flash-latest
  ...
```

**5. Make it yours**

```bash
nexus model list                 # browse the models you can pick
nexus claude --model glm-latest  # choose one (or pin tiers: --sonnet <id>)
nexus harnesses                  # every harness and whether it's connected
nexus claude off                 # back to exactly how things were
```

Use any harness name in place of `claude`: `claude-desktop`, `opencode`, `codex` (or `chatgpt`),
`pi`, `cursor`, `vscode`, `copilot-app`, `copilot-cli`, `deepseek`. Run `nexus help` or
`nexus <harness> help` for every option.

### Install notes

- You need **bash** and **Node.js 22+**. If Node is missing or too old, the installer sets it up via Homebrew on macOS, or points you to nvm / nodejs.org / NodeSource elsewhere.
- The installer puts the CLI in `~/.nexus/cli`, adds the `nexus` launcher to `~/.local/bin` and your shell `PATH`, and runs the same cleanup as `nexus update`. It does not sign you in or change harness settings — that's steps 2 and 3.
- **Windows:** run the install from Git Bash. Piping it through PowerShell breaks line endings (`set: pipefail\r`).

**From an SSH checkout:**

```bash
tmp="$(mktemp -d)" && git clone --depth 1 git@github.com:fw-ai/nexus-cli.git "$tmp" \
  && NEXUS_SOURCE=git@github.com:fw-ai/nexus-cli.git bash < "$tmp/install.sh"
```

## Supported harnesses

Run `nexus harnesses` to see this list along with which harnesses are connected on your machine.
Every harness supports `on`, `off`, `status`, and `help`, and every model change goes through
`<harness> on`. Settings apply per session — restart the harness (or start a new session) after `on`/`off`.

| Harness | Command | Settings it edits | Before `on` / `off` |
|---------|---------|-------------------|---------------------|
| [Claude Code](#claude-code) | `nexus claude` | `~/.claude/settings.json` | Restart after |
| [Codex](#codex) | `nexus codex` / `nexus chatgpt` | `~/.codex/config.toml` | Restart after |
| [OpenCode](#opencode) | `nexus opencode` | `~/.config/opencode/opencode.json` | Restart after |
| [Pi](#pi) | `nexus pi` | `~/.pi/agent/{settings,models,auth}.json` | Restart after |
| [Cursor](#cursor) | `nexus cursor` | `state.vscdb` (SQLite) | **Quit Cursor first** |
| [VS Code Chat](#vs-code-chat) | `nexus vscode` | `chatLanguageModels.json` + `state.vscdb` | **Quit VS Code first** |
| [GitHub Copilot app](#github-copilot-app) | `nexus copilot-app` | `~/.copilot/data.db` (SQLite) | **Quit Copilot first** |
| [GitHub Copilot CLI](#github-copilot-cli) | `nexus copilot-cli` | `~/.copilot/providers.json` + `settings.json` | Restart `copilot` after |
| [DeepSeek Harness](#deepseek-harness) | `nexus deepseek` | `~/.dsh/settings.yaml` + patch layers | Restart `dsh` after |
| [Claude Desktop](#claude-desktop) | `nexus claude-desktop` | Claude-3p provider profile + loopback shim | **Quit and reopen Desktop after** |

`off` restores from a snapshot kept under `~/.nexus/` (files) or removes exactly what Nexus
added (IDEs and databases). Your own providers, models, and settings are never touched.

## Default models

Every harness starts on **`auto`**, Fireworks' smart router: it picks a model per user turn
across Fireworks open models, so everything works with zero configuration. Pin a concrete
model whenever you want one model for every turn:

```bash
nexus model list                    # what you can pick (prices included)
nexus <harness> --model glm-latest  # pin one model
nexus <harness>                     # re-run to refresh the picker; your pick stays
```

| Harness | Default | Notes |
|---------|---------|-------|
| Claude Code tiers (`opus`/`sonnet`/`haiku`/`fable`/subagents) | Claude's own defaults | Pin with `--opus` / `--sonnet` / `--haiku` / `--fable` / `--subagent`; `native` unpins |
| Claude `/model` picker | Serverless catalog appended | `--model <id>` selects a row and ensures it's listed |
| Everything else | `auto` | Codex signs in with ChatGPT for GPT turns ([details](#signing-in-with-chatgpt)) |

Re-running `nexus <harness>` refreshes the registered catalog (new models added, retired
ones pruned, metadata re-rendered) and keeps your pick — with one exception: a retired-router
pick (FireRouter, `auto-instant`) moves to `auto`. Both routers are retired; selecting them
is rejected in favour of `auto` (see [FireRouter](#firerouter)).

## Claude Code

```bash
nexus claude                       # connect; catalog lands in /model
nexus claude --model <id>          # select a model and ensure it's in /model
nexus claude --sonnet <id> --subagent <id>  # pin tier slots (native unpins)
nexus claude status                # mapping, auth, and per-slot rates (--json for scripts)
nexus claude usage                 # live session meter at Fireworks rates
nexus claude live                  # tmux split: Claude Code left, live meter right
nexus claude demo                  # race two models on a prompt (needs routing on)
nexus claude off
```

**How it routes.** Nexus appends the Fireworks catalog to `/model` and leaves the Anthropic
tier slots on Claude's own defaults unless you pin them. Auth is a static
`X-Fireworks-Api-Key` header in `settings.json` (owner-only file; the OS keychain stays the
source of truth), which wins over any stray `ANTHROPIC_API_KEY`, so a leftover key can't
quietly break routing. An exact backup is kept for `off`.

**Notes that matter:**

- **Costs shown in Claude Code are not your bill.** Claude Code estimates at Anthropic list
  prices; Fireworks bills at serverless rates. Trust `nexus claude status`, `nexus model list`,
  and the [billing dashboard](https://app.fireworks.ai/account/billing). The optional
  [status line](#status-line) shows per-model cost at Fireworks rates.
- **`[1m]` tags are normal.** Picker rows for 1M-context models carry a `[1m]` suffix so
  Claude Code sizes the window correctly; it strips the tag before sending. Other harnesses
  use the bare name.
- **Text-only models + images can break a session.** `nexus claude status` marks each model
  `vision` or `text-only`; recover a broken session with `/rewind`.
- Native `WebSearch`/`WebFetch` keep working through the gateway; your own MCPs and
  permission rules are untouched.

### Status line

`on` adds a `statusLine` (only if you don't already have one) showing which model served
each call and what it cost at Fireworks rates:

```text
━━━━━━━━━━━━ ━ ━ · $70.39 · routed model: Claude Opus 5
━ Claude Opus 5 $62.91 98% cache · ━ GLM 5.2 $7.35 96% cache · ━ DeepSeek V4 Flash $0.13 87% cache
```

It reads the session transcript, so mid-session model switches are priced by the model that
actually served each call. `off` removes it; `NO_COLOR` gives plain text.

## Codex

Sends [OpenAI Codex CLI](https://developers.openai.com/codex) (and the ChatGPT desktop app,
which shares `~/.codex`) through Fireworks via the Responses API.

```bash
nexus codex                       # writes ~/.codex/config.toml (auto, ChatGPT sign-in)
nexus codex status
nexus codex --model glm-latest    # switch model
nexus codex off
```

### Signing in with ChatGPT

Codex keeps its own sign-in. The first `nexus codex` selects `auto` and sets
`requires_openai_auth = true`, so Codex asks you to sign in (`codex login`) and sends that
sign-in with each request; your Fireworks key rides in its own `x-fireworks-api-key` header.
GPT turns are paid by, in order:

1. **Codex's sign-in** — your ChatGPT plan, or the OpenAI key you signed in with
   (`codex login --with-api-key`; no browser: `codex login --device-auth`, or
   `nexus key export --openai | codex login --with-api-key`).
2. **An OpenAI Provider Key** on your Fireworks account ([Provider Keys](https://docs.fireworks.ai/nexus/provider-keys)).

With neither, GPT models fail but `auto` keeps working on open models. The `/model` picker
lists stock Codex's GPT models first (read with `codex debug models`, so new ones appear as
Codex offers them), then the Fireworks catalog. A re-run keeps the model you're on.

**Notes that matter:**

- **Threads keep the provider they started on.** ChatGPT app threads started on OpenAI stay
  on OpenAI; start a new thread for Fireworks. Resuming a CLI session needs the provider on:
  `codex resume <id> -c model_provider="fireworks-ai"`.
- **MiniMax doesn't work on Codex** (its templates reject Codex's message shape);
  `codex --model minimax-latest` explains. Use a Chat Completions harness instead.
- **Quit the ChatGPT app before `on`/`off`** (it caches config at boot), like the IDEs;
  `--force` writes anyway, not recommended. `nexus chatgpt` is the same command.
- Like the IDEs, quit the ChatGPT app before `on`/`off` (`--force` writes anyway, not recommended).

## OpenCode

Adds a `provider.fireworks-ai` block to `~/.config/opencode/opencode.json`, sets the default
model, and registers the preferred catalog for `/model` (skipping models OpenCode already
lists from models.dev, so nothing shows twice). Your key is saved in the file (owner-only).
OpenCode v2's `providers` map is written too when present. Offline, it falls back to the
active model. `--config-path <path>` for a config elsewhere.

```bash
nexus opencode
nexus opencode --model glm-latest
nexus opencode off
```

## Pi

Sets `defaultProvider`/`defaultModel` in `~/.pi/agent/settings.json`, registers the catalog
(full `accounts/fireworks/...` IDs, so rows line up with Pi's own) in `models.json`, and saves
your key in `auth.json`. All three files are backed up; `off` removes only what Nexus added.
`--settings-path <path>` for a settings file elsewhere.

```bash
nexus pi
nexus pi --model glm-latest
nexus pi off
```

## Cursor

> **Quit Cursor (`Cmd-Q`) before `on` or `off`** — a running Cursor overwrites your edit from
> memory. Nexus waits in the terminal, offers to continue after ~90s, and `--force` skips the wait.

Nexus writes Cursor's `state.vscdb` directly: your key goes to its secure storage, the base
URL points at Fireworks, and Fireworks models are registered per mode. `--model <id>` applies
to every mode you already have (it never invents modes). While connected, **only Fireworks
models answer** — Cursor's built-ins are hidden until `nexus cursor off`, which removes only
what Nexus added. `--db-path <path>` for a non-default database (e.g. Insiders).

```bash
nexus cursor --api-key fw_...
nexus cursor --model glm-fast-latest
nexus cursor off
```

## VS Code Chat

> **Quit VS Code before `on` or `off`**, same rule as Cursor.

Adds a `Fireworks` provider to `chatLanguageModels.json`; your key is **not** in that file —
it lives encrypted (Electron `safeStorage`) in VS Code's `state.vscdb` under a
`chat.lm.secret.fw-*` id. On Linux that needs `libsecret` for real encryption (Nexus writes
either way, with a warning). `off` restores the JSON exactly and deletes the secret row;
providers you set up yourself are untouched. `--vscode-path <path>` for a non-default file.

```bash
nexus vscode --api-key fw_...
nexus vscode --model deepseek-flash-latest
nexus vscode off
```

## GitHub Copilot app

Adds one `fc-` provider (with its model rows) to the desktop app's `~/.copilot/data.db`;
your key rides as an `Authorization` header on that row (the file is owner-only). Your
built-in Copilot models keep working alongside it, and `off` deletes exactly Nexus's rows.
BYOK models in the app don't get image input, the hover Context row, or AI-credits pricing.

> **Quit GitHub Copilot before `on` or `off`**, same rule as Cursor.

```bash
nexus copilot-app --api-key fw_...
nexus copilot-app --model glm-latest
nexus copilot-app off
```

## GitHub Copilot CLI

Routes the `copilot` command through Fireworks with plain JSON: a `fireworks` provider plus
one row per model in `~/.copilot/providers.json`, and the selected model in `settings.json`
(a BYOK provider has no default, and the CLI won't start without one). **Pick models with
the provider attached** — `copilot --model fireworks/glm-latest` or `/model`; a bare name is
rejected and quietly falls back. Per-model image input is supported; context/reasoning/pricing
aren't shown for BYOK models. `off` restores `providers.json` from its snapshot and keeps
anything you added yourself. The desktop app and the CLI share a folder but no settings —
turn on either, both, or neither.

```bash
nexus copilot-cli --api-key fw_...
nexus copilot-cli --model glm-latest
nexus copilot-cli off
```

## DeepSeek Harness

Sends [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) through
Fireworks: writes the `fireworks` provider and default model into `~/.dsh/settings.yaml`
plus the `cordis.patch.yml` layers dsh composes over it, and saves your key as
`FIREWORKS_API_KEY` in `~/.dsh/.credentials.yaml` (owner-only). `--config-path <path>` for a
`settings.yaml` elsewhere (credentials stay next to that file).

```bash
nexus deepseek
nexus deepseek --model glm-latest
nexus deepseek off
```

## Claude Desktop

Runs Claude Desktop's Chat, Cowork, and Code surfaces on Fireworks models, starting on
`auto`, with the Fireworks line-up and per-model effort menus in the picker.

```bash
nexus claude-desktop on                # switch Desktop to Fireworks; imports your connectors
nexus claude-desktop on --model <id>   # add a serverless model to the picker
nexus claude-desktop mcp sync          # re-import connectors you've added since
nexus claude-desktop off               # restore your previous setup
```

Quit and reopen Desktop after `on`/`off`. Requires macOS or Linux and a stored credential
(`nexus login`). Linux is unofficial: Anthropic documents Desktop's third-party mode for
macOS and Windows only, but the Linux build ships the same mechanism and Nexus drives it
the same way.

**How it works.** `on` writes a third-party inference provider profile (Desktop's own
mechanism) pointing at a small loopback shim service (launchd on macOS, systemd user unit
on Linux) that maps model names and mirrors the model catalog. The shim auto-starts at
login; if it's ever down, `nexus claude-desktop status` says so and `on` brings it back. On
Linux, `on` needs a systemd user session (the normal case when logged in).

**Connectors are managed through Nexus** — Desktop's in-app connector browser is suppressed
in third-party mode:

- `on` imports connectors from your session history, previous Desktop config, and claude.ai
  org registry. Each needs a **one-time re-auth** the first time you use it.
- `mcp sync` re-imports; `mcp add <name> <url>` / `mcp remove <name>` manage entries by hand.
  Your connector setup survives `off`/`on`.
- **Google connectors** (Gmail, Drive, Calendar, BigQuery) and **Figma** can't self-register:
  register your own OAuth client once, e.g.
  `nexus claude-desktop mcp add gmail https://gmailmcp.googleapis.com/mcp/v1 --client-id "<ID>.apps.googleusercontent.com" --client-secret "GOCSPX-..."`,
  or use Figma's local server: `nexus claude-desktop mcp add figma-desktop http://127.0.0.1:3845/mcp`.

**What changes in third-party mode** (Claude Desktop's rules, not Nexus bugs):

| Change | Workaround |
|---|---|
| In-app connector browser / one-click add is gone | `mcp sync` / `mcp add` |
| Connectors relying on your claude.ai sign-in need an OAuth client | Google/Figma recipes above |
| Chat, Cowork and Code use the Fireworks picker, not your claude.ai subscription models | `off` restores them |
| Third-party mode does not show your claude.ai chats, projects, artifacts, memory, or scheduled tasks. Nothing is deleted, and `off` brings them back. | Recreate what you need while connected |
| New chats, projects, artifacts, and memory are saved only on this computer. They don't appear on claude.ai web or mobile and can't be shared. | Run `off` to share or work on the web |
| Skills and plugins are copied over on `on`. Run `on` again to copy ones you add later. | Re-run `nexus claude-desktop on` |
| Scheduled tasks run only while the computer is awake; Chat has no past-chat search; voice mode is unavailable | `off` restores them |

Anthropic's own summary: [third-party feature matrix](https://claude.com/docs/third-party/claude-desktop/feature-matrix).
If `status` shows the shim NOT RESPONDING, run `nexus claude-desktop on` to restart it.

## FireRouter

FireRouter (and its latency-first sibling `auto-instant`) used to route each user turn
between closed models and Fireworks open models. Both are **retired as model selections**:
Nexus no longer connects any harness through them, and `auto` is the routed default.

**Selecting one fails**, on every harness (including Claude tier-slot flags):

```text
✗ Error: --model firerouter is a FireRouter route, which is no longer supported. Use --model auto instead.
```

Nothing is written and no key is stored. Use `--model auto` for routed turns, or name a
concrete model from `nexus model list`.

**Already on one?** A stored selection is moved to `auto` for you: upgrading rewrites the
live selection on every harness, re-running `nexus <harness>` does the same, and retired
picker rows leave with it. `status` and `off` still read a stored config, so nothing breaks
before you upgrade.

**Frontier models without FireRouter.** Claude turns are paid by Claude Code's own sign-in
(`claude login`) or an Anthropic [Provider Key](https://docs.fireworks.ai/nexus/provider-keys);
GPT turns by Codex's own sign-in or an OpenAI Provider Key. The `--anthropic-api-key` /
`--openai-api-key` flags on `<harness> on` only ever served FireRouter and are retired with
it (Claude's `--openai-api-key` still stores the key). Clear saved keys anytime with
`nexus configure --unset anthropic-api-key` (or `--unset openai-api-key`).

> The old `--router` flag is gone. Use `--model auto`. `--routing-preference` is deprecated
> and has no effect.

FireRouter as a gateway product: [FireRouter overview](https://docs.fireworks.ai/ecosystem/firerouter/overview).

## Models

```bash
nexus model list                 # browse (alias: nexus models)
nexus model list --search glm
nexus model list --refresh       # skip the 1-hour cache
nexus model list --json
```

Lists coding-ready serverless models plus the `-latest` router aliases
(`glm-latest`, `kimi-fast-latest`, `minimax-latest`, …). Prefer the aliases over pinned
versions — they follow new releases on their own. Results are cached for **1 hour**;
offline, the last cached list is shown instead of an error. Retired routers never appear
(see [FireRouter](#firerouter)).

**Short names everywhere.** `glm-latest` and full `accounts/fireworks/...` IDs both work;
harnesses store the form they use themselves (Pi stores full IDs, most others short names).
US-only routers take short names too (see [US-only Serverless](https://docs.fireworks.ai/serverless/us-only-serverless)):

```bash
nexus claude on --model kimi-k3-us
nexus opencode on --model glm-5p3-flash-us
```

Which key is used, in order: `--api-key` → `FIREWORKS_API_KEY` → saved key. For rates,
`nexus model list` and `nexus claude status` show Fireworks serverless pricing — not the
Anthropic list prices Claude Code displays (see [Pricing estimates](#pricing-estimates)).

### Pricing estimates

Claude Code's picker and session estimates use **Anthropic list prices**, while Fireworks
bills at **serverless rates**, so the in-app number can look much higher than your real bill.
Trust `nexus claude status`, `nexus model list`, and the
[billing dashboard](https://app.fireworks.ai/account/billing).

## Azure (Microsoft Foundry) endpoints

Fireworks models are also first-party models inside
[Microsoft Foundry](https://docs.fireworks.ai/ecosystem/integrations/azure-foundry), billed
through Azure. Foundry speaks an OpenAI-compatible API, so **OpenCode, Pi, Cursor, and
VS Code** can point there instead of the Fireworks gateway (Claude Code and Codex can't —
neither speaks Foundry's transport).

```bash
nexus configure --provider azure \
  --base-url https://<resource>.services.ai.azure.com \
  --api-key <azure-api-key>

nexus opencode      # goes through your Foundry endpoint
```

- **Endpoint.** Whatever you paste (resource root, portal project endpoint, `/models` route)
  is tidied into `https://<resource>.services.ai.azure.com/openai/v1`. Find it under
  **Project settings** in the Foundry portal.
- **Auth.** Your **Azure** key (not `fw_`), saved as-is or as an `$AZURE_API_KEY` reference.
- **Model.** Your Foundry **deployment** name (the catalog name without the `fireworks-ai/`
  prefix, e.g. `FW-GLM-5.2`). Defaults to `FW-GLM-5.2`; pick per run with `--model`, or
  per command with `--azure --base-url …`.
- Each harness gets its own `fireworks-azure` provider; `off` restores exactly, and
  `nexus configure --provider fireworks` switches back. `model list` doesn't apply in Azure mode.

| Harness | Provider |
|---------|----------|
| OpenCode | `provider.fireworks-azure` in `opencode.json` |
| Pi | custom `openai-completions` provider in `models.json` |
| Cursor | OpenAI-compatible URL, deployment, and key in `state.vscdb` |
| VS Code | custom endpoint model in `chatLanguageModels.json`; key in `safeStorage` |

## CLI reference

Harness-first: `nexus <harness> <command>`, plus a few global commands.
`nexus <harness>` with no command runs `on`.

**Per harness** (`claude`, `claude-desktop`, `opencode`, `codex` / `chatgpt`, `pi`, `cursor`, `vscode`, `copilot-app`, `copilot-cli`, `deepseek`)

```text
nexus <harness> on           Send the harness through Fireworks (the default when no command given).
nexus <harness> off          Bring back your previous provider/config.
nexus <harness> status       Show the provider, auth, and model mapping.
nexus <harness> status --json  Same state as JSON (for CI checks).
nexus <harness> help         Help for that harness.
```

Claude adds `nexus claude usage`, `nexus claude live`, and `nexus claude demo`.

**Global**

```text
nexus login                  Sign in: browser (creates a key) or paste a key you have.
nexus logout                 Clear the stored key (keychain entry + config ref).
nexus status                 Show sign-in state, machine environment, and key storage.
nexus harnesses              List every supported harness and whether it is connected.
nexus model list             Browse the serverless catalog (`models` is an alias).
nexus configure              Set the provider (Azure/Foundry) and the BYOK keys.
nexus configure --unset openai-api-key   Clear the saved OpenAI key (`--unset anthropic-api-key` for Anthropic).
nexus auto                   Show the auto router's provider scope.
nexus auto --providers fireworks   Route auto only to Fireworks-hosted models, then run `nexus <harness>` again.
nexus auto --reset           Back to the default scope.
nexus update                 Update Nexus (`upgrade` is an alias).
nexus uninstall              Switch off + restore every harness, then remove Nexus.
nexus --version              Print the installed CLI version (-V; --json for machine-readable).
nexus help                   Show help (`help <topic>` or `<harness> help`).
```

`nexus auto` narrows the `auto` router globally (not per harness): with nothing saved it
auto-selects based on your setup; `--providers fireworks` restricts it to Fireworks-hosted
models (the only provider today). Run `nexus <harness>` again per harness to apply it.
Your account's model restrictions always apply first.

## Keys and storage

- `~/.nexus/config.json` holds a **reference** (`{keychain:fireworks-api-key}`), never the key
  itself. The key lives in the OS keychain, or an encrypted-file/plaintext fallback when no
  secret service exists (`nexus status` says which).
- `login` creates a machine key in the browser or checks a pasted one live; `--paste` skips
  the question, `--with-token` reads stdin (CI), `--account <id>` targets enterprise SSO.
  On success it re-saves the key into every connected harness that keeps its own copy, so a
  rotated key reaches all of them. `logout` can also revoke the machine key server-side.
- Some harness configs hold their own copy of the key (Claude's header, Codex, OpenCode, Pi,
  DeepSeek); Cursor and VS Code use IDE `safeStorage`. Files that hold keys are owner-only.
- `nexus configure --unset <key>` clears a saved Anthropic/OpenAI key and removes it from
  every harness that stored a copy (Claude Code keeps an Anthropic key it signs in with).
- `--home <path>` overrides HOME for config lookup; `--data-dir <path>` moves the
  backup/state folder — handy for sandboxes and tests.

**`FIREWORKS_API_KEY` interaction.** When it's set, `login` uses it without copying it into
secret storage, and combining `login` with a key-saving option fails before changing
anything. Unset it first. `<harness> on` may still read, save, and bake it into a config.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Harness still uses the old model or provider | Fully restart the harness (Claude Code: exit and `claude --resume <id>`). Settings apply per session. |
| Cursor / VS Code / Copilot changes don't stick | Quit the app (`Cmd-Q`) **before** `on`/`off`; a running app saves over your edit. |
| Only Fireworks models answer in Cursor | Expected while connected. `nexus cursor off` brings back built-ins. |
| `--model firerouter…` or `--model auto-instant` is rejected | Both routers are retired. Use `--model auto` (or a concrete model from `nexus model list`). |
| A picker or config still shows `firerouter` | Re-run `nexus <harness>` (or `nexus update`): the selection moves to `auto` and retired rows are dropped. |
| Claude Code shows a scary cost estimate | It uses [Anthropic list prices](#pricing-estimates). Check `nexus claude status` for Fireworks rates. |
| Claude session breaks after pasting an image | A [text-only](#text-only-models-and-images) model was active. `/rewind`, then pick a vision model. |
| A harness gets 401s after you rotated your key | Run `nexus login` — it re-saves the new key everywhere. Quit VS Code first. |
| `login` fails with a key-storage conflict | `FIREWORKS_API_KEY` is set. Unset it so Nexus can store a key. |
| ChatGPT app thread ignores Fireworks models | Threads keep the provider they started on. Start a new thread (see [Codex](#codex)). |
| Something else | `nexus status` shows sign-in, environment, storage, and every harness's state. |

### Text-only models and images

Claude Code can't tell which models see images, so pasting an image on a text-only model can
break the session. `nexus claude status` marks every model `vision` or `text-only`, and
adding a text-only model with `--model` prints a one-line warning. Recover with `/rewind`.

## Update and uninstall

```bash
nexus update          # or re-run the installer
nexus uninstall        # restores every harness, then removes ~/.nexus and the launcher
nexus uninstall --force   # no questions (CI / scripts)
```

Upgrades leave your settings alone apart from re-saving keys and small forward migrations
(VS Code's provider `apiType`, Claude's `ENABLE_TOOL_SEARCH`, catalog refresh in each
picker, Codex's sign-in mode, and moving retired-router selections to `auto`). The final
step runs in a fresh process, so migrations come from the new version.

**Coming from FireConnect (pre-0.10.0)?** Re-run the installer above once: it replaces the
old command with `nexus`, moves `~/.fireconnect` to `~/.nexus`, and keeps your harnesses,
key, and settings. From then on every command is `nexus` — and rename any `FIRECONNECT_*`
variables to `NEXUS_*`. Upgrading from
**before 0.9.0** with Claude connected asks before briefly restoring your original settings,
then tells you to reconnect with `nexus claude`.
