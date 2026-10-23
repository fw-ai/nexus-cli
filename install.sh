#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${FIREWORKS_BASE_URL:-https://api.fireworks.ai/inference}"
# When install.sh is piped (curl | bash), BASH_SOURCE[0] is unset; bootstrap from git.
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CLI="${SCRIPT_DIR}/packages/setup-cli/bin/nexus.mjs"
else
  SCRIPT_DIR=""
  CLI=""
fi
# Honor pre-rename FIRECONNECT_* variables under their NEXUS_* names.
while IFS= read -r legacy_var; do
  current_var="NEXUS_${legacy_var#FIRECONNECT_}"
  [[ -n "${!current_var+x}" ]] || export "${current_var}=${!legacy_var}"
done < <(compgen -e | grep '^FIRECONNECT_' || true)

DEFAULT_SOURCE="https://github.com/fw-ai/nexus-cli.git"
SOURCE="${NEXUS_SOURCE:-${DEFAULT_SOURCE}}"
MIN_NODE_MAJOR=22
CLAUDE_SETTINGS_RESTORED=0
INSTALL_NOTES=()

install_progress() {
  echo "→ $*"
}

install_note() {
  INSTALL_NOTES+=("$1")
}

print_install_notes() {
  local note
  # Empty "${array[@]}" is an unbound variable under `set -u` on Bash 3.2 (macOS).
  ((${#INSTALL_NOTES[@]})) || return 0
  for note in "${INSTALL_NOTES[@]}"; do
    echo "Note: ${note}"
  done
}

node_major_version() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0"
}

node_meets_minimum() {
  local major
  major="$(node_major_version)"
  [[ "${major}" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR ))
}

print_node_upgrade_instructions() {
  echo "Install Node.js ${MIN_NODE_MAJOR}+ and rerun this installer." >&2
  echo >&2
  echo "Options:" >&2
  echo "  - https://nodejs.org/en/download" >&2
  echo "  - nvm: https://github.com/nvm-sh/nvm#installing-and-updating" >&2
  if command -v apt-get >/dev/null 2>&1; then
    echo "  - NodeSource on Debian/Ubuntu (review the setup script before running it):" >&2
    echo "      curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x -o /tmp/nodesource-setup.sh" >&2
    echo "      less /tmp/nodesource-setup.sh" >&2
    echo "      sudo bash /tmp/nodesource-setup.sh && sudo apt-get install -y nodejs" >&2
  fi
}

ensure_node_runtime() {
  # Windows (Git Bash / MSYS / Cygwin): Node is frequently installed but not on
  # the PATH the shell inherits (e.g. C:\Program Files\nodejs). Probe the common
  # install location and add it to PATH for this session before giving up, so
  # the installer doesn't dead-end when Node is present. (gh fw-ai/nexus-cli#11)
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      if ! command -v node >/dev/null 2>&1; then
        local win_node candidates=() win_pf
        # Guard the cygpath call inside an `if` so a non-zero exit can't abort
        # the whole installer under `set -e` before the fallback candidate below.
        if command -v cygpath >/dev/null 2>&1 && [[ -n "${PROGRAMFILES:-}" ]] \
          && win_pf="$(cygpath -u "${PROGRAMFILES}" 2>/dev/null)"; then
          candidates+=("${win_pf}/nodejs")
        fi
        candidates+=("/c/Program Files/nodejs")
        for win_node in "${candidates[@]}"; do
          if [[ -x "${win_node}/node.exe" || -x "${win_node}/node" ]]; then
            PATH="${win_node}:${PATH}"
            export PATH
            break
          fi
        done
      fi
      ;;
  esac

  if command -v node >/dev/null 2>&1 && node_meets_minimum; then
    return
  fi

  if command -v node >/dev/null 2>&1; then
    local current
    current="$(node -p "process.versions.node" 2>/dev/null || echo "unknown")"
    echo "Node.js ${MIN_NODE_MAJOR}+ is required (found ${current})." >&2
  else
    echo "Node.js ${MIN_NODE_MAJOR}+ is required for setup." >&2
  fi
  echo "The installer uses Node to update settings; it does not install or update npm packages." >&2

  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    # Prompt from the controlling terminal so this works under `curl … | bash`,
    # where stdin is the script stream (a plain `read -p` prompt never shows and
    # would consume the next line of the script). (gh fw-ai/nexus-cli#11)
    if [[ -r /dev/tty ]]; then
      read -r -p "Install Node.js with Homebrew now? [y/N] " install_node </dev/tty
    else
      read -r -p "Install Node.js with Homebrew now? [y/N] " install_node
    fi
    if [[ ! "${install_node}" =~ ^[Yy]$ ]]; then
      print_node_upgrade_instructions
      exit 1
    fi

    echo "Installing Node.js with Homebrew..."
    brew install node
  else
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        echo "On Windows, install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org/ (or add an existing install, e.g. C:\\Program Files\\nodejs, to your PATH) and re-run this script." >&2
        ;;
    esac
    print_node_upgrade_instructions
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Missing required command: node" >&2
    exit 1
  fi

  if ! node_meets_minimum; then
    local current
    current="$(node -p "process.versions.node" 2>/dev/null || echo "unknown")"
    echo "Node.js ${MIN_NODE_MAJOR}+ is still required after install (found ${current})." >&2
    print_node_upgrade_instructions
    exit 1
  fi
}

# An existing install may predate the rename and only have `fireconnect`.
existing_cli() {
  local home_launcher path_launcher
  home_launcher="${HOME}/.local/bin/nexus"
  if [[ -e "${home_launcher}" ]] && grep -qE 'packages[\\/]setup-cli[\\/]bin[\\/](nexus|fireconnect)\.mjs' "${home_launcher}" 2>/dev/null; then
    printf '%s\n' "${home_launcher}"
    return
  fi
  home_launcher="${HOME}/.local/bin/fireconnect"
  if [[ -e "${home_launcher}" || -L "${home_launcher}" ]]; then
    printf '%s\n' "${home_launcher}"
    return
  fi

  path_launcher="$(command -v fireconnect 2>/dev/null || true)"
  if [[ -n "${path_launcher}" ]]; then
    printf '%s\n' "${path_launcher}"
  fi
}

# Print the durable-install Nexus version (empty when unknown).
# Keep the threshold in sync with CLAUDE_OFF_UPGRADE_BEFORE_VERSION in
# packages/setup-cli/lib/system/upgrade.mjs.
installed_fireconnect_version() {
  local pkg="${HOME}/.nexus/cli/packages/setup-cli/package.json"
  if [[ ! -f "${pkg}" ]]; then
    return 0
  fi
  # Use `node -` (argv[2]=path) like the other helpers in this file — not
  # `node -p`/`-e`, whose argv layout differs across Node versions.
  node - "${pkg}" <<'NODE'
const fs = require("node:fs");
const pkgPath = process.argv[2];
try {
  const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "";
  process.stdout.write(String(version));
} catch {
  // Leave stdout empty on parse/IO failure.
}
NODE
}

# Exit 0 when Claude-off preflight is still required (installed < 0.9.0 or unknown).
# From FireConnect 0.9.0 on, harness settings are preserved across upgrade.
needs_claude_off_before_upgrade() {
  version_below "${1:-}" "0.9.0"
}

# Exit 0 when version $1 is below $2, or unknown.
version_below() {
  local version="${1:-}"
  node - "${version}" "$2" <<'NODE'
const raw = (value) => String(value ?? "").trim().replace(/^v/i, "");
const parts = (value) => raw(value).split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
const left = raw(process.argv[2]);
const right = raw(process.argv[3]);
if (!left) {
  process.exit(0);
}
const leftParts = parts(left);
const rightParts = parts(right);
for (let index = 0; index < 3; index += 1) {
  const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
  if (difference !== 0) {
    process.exit(difference < 0 ? 0 : 1);
  }
}
process.exit(1);
NODE
}

# Exit 0 when Claude is still FireConnect-managed, 1 when it is not, and 2
# when the state cannot be inspected safely.
claude_is_fireconnect_enabled() {
  node - "${HOME}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const home = process.argv[2];

function readJson(relativePath) {
  const filePath = path.join(home, relativePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    console.error(`Unable to inspect ${filePath}: ${error.message}`);
    process.exit(2);
  }
}

const globalConfig = readJson(".nexus/config.json");
if (globalConfig?.harnesses?.claude?.enabled === true) {
  process.exit(0);
}

const settings = readJson(".claude/settings.json");
const env = settings?.env && typeof settings.env === "object" ? settings.env : {};
let hostname = "";
try {
  hostname = new URL(env.ANTHROPIC_BASE_URL).hostname.toLowerCase();
} catch {
  process.exit(1);
}
if (hostname !== "fireworks.ai" && !hostname.endsWith(".fireworks.ai")) {
  process.exit(1);
}

const backup = readJson(".nexus/claude/provider-backup.json");
const state = readJson(".nexus/claude/provider-state.json");
const headers = typeof env.ANTHROPIC_CUSTOM_HEADERS === "string"
  ? env.ANTHROPIC_CUSTOM_HEADERS.split("\n").map((line) => {
    const colon = line.indexOf(":");
    return colon === -1
      ? { name: "", value: "" }
      : {
          name: line.slice(0, colon).trim().toLowerCase(),
          value: line.slice(colon + 1).trim(),
        };
  })
  : [];
const header = (name) => headers.find((entry) => entry.name === name)?.value ?? "";
const hasTelemetry = headers.some(({ name, value }) => [
  "x-firerouter-harness",
  "x-title",
  "fireworks-use-case",
  "http-referer",
].includes(name) || (name === "user-agent" && /^(fireconnect|nexus)\//i.test(value)));
const mappingKeys = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];
const isFireworksModelMapping = (value) => {
  if (typeof value !== "string") {
    return false;
  }
  const model = value.trim();
  return model.startsWith("accounts/fireworks/")
    || /^[a-z0-9][a-z0-9._-]*(?:\[1m\])?$/i.test(model);
};
const hasFireworksMapping = mappingKeys.some(
  (key) => isFireworksModelMapping(env[key]),
);
const fireworksHeader = header("x-fireworks-api-key");
const currentHelper = typeof settings.apiKeyHelper === "string" ? settings.apiKeyHelper : "";
const hasManagedHelper = (
  typeof state.managedApiKeyHelper === "string"
  && currentHelper === state.managedApiKeyHelper
) || (
  /(?:^|[/\\])fireconnect(?:\.mjs)?['"]?(?:\s|$)/.test(currentHelper)
  && /(?:^|\s)key\s+export(?:\s|$)/.test(currentHelper)
);
const hasManagedEvidence = Object.hasOwn(backup, "snapshot")
  || Object.hasOwn(backup, "values")
  || Boolean(state.authMode || state.managedApiKeyHelper)
  || hasManagedHelper
  || env.ANTHROPIC_API_KEY === "fireconnect"
  || Boolean(header("x-firerouter-fireworks-key"))
  || hasTelemetry
  || (
    (fireworksHeader.startsWith("fw_") || fireworksHeader.startsWith("fpk_"))
    && hasFireworksMapping
  );

process.exit(hasManagedEvidence ? 0 : 1);
NODE
}

confirm_claude_restore() {
  local response
  if ! exec 3<>/dev/tty; then
    echo "Claude Code must be disconnected before upgrading, but no interactive terminal is available." >&2
    echo "Rerun in a terminal, or set NEXUS_AUTO_OFF_CLAUDE=1 for automated installation." >&2
    return 1
  fi

  printf 'Claude Code is currently connected through FireConnect.\n\nFireConnect must temporarily restore your original Claude settings before upgrading.\n\nContinue? [Y/n] ' >&3
  if ! IFS= read -r response <&3; then
    exec 3>&-
    echo "Installation cancelled; Claude Code settings were not changed." >&2
    return 1
  fi
  exec 3>&-

  case "${response}" in
    ""|[Yy]|[Yy][Ee][Ss]) return 0 ;;
    *)
      echo "Installation cancelled; Claude Code settings were not changed." >&2
      return 1
      ;;
  esac
}

preflight_existing_install() {
  local installed_cli
  installed_cli="$(existing_cli)"
  if [[ -z "${installed_cli}" ]]; then
    return
  fi

  # FireConnect >= 0.9.0 preserves harness settings across reinstall/upgrade —
  # never prompt to disable Claude (or any other harness).
  local installed_version
  installed_version="$(installed_fireconnect_version)"
  if ! needs_claude_off_before_upgrade "${installed_version}"; then
    return
  fi

  local detection_status
  if claude_is_fireconnect_enabled; then
    detection_status=0
  else
    detection_status=$?
  fi
  if (( detection_status == 1 )); then
    return
  fi
  if (( detection_status != 0 )); then
    echo "Installation stopped because the existing Claude Code configuration could not be inspected safely." >&2
    return 1
  fi

  if [[ "${NEXUS_AUTO_OFF_CLAUDE:-}" != "1" ]]; then
    confirm_claude_restore
  fi

  # Releases before 0.4.0 (they report 0.2.0) only know the top-level `off`.
  local off_command=(claude off)
  if [[ -n "${installed_version}" ]] && version_below "${installed_version}" "0.4.0"; then
    off_command=(off)
  fi
  echo "Restoring your original Claude Code settings before upgrading..."
  if ! "${installed_cli}" "${off_command[@]}"; then
    echo "Installation stopped because the existing FireConnect CLI could not restore Claude Code settings." >&2
    return 1
  fi

  if claude_is_fireconnect_enabled; then
    echo "Installation stopped because Claude Code is still managed by FireConnect after running 'claude off'." >&2
    return 1
  else
    detection_status=$?
  fi
  if (( detection_status != 1 )); then
    echo "Installation stopped because the restored Claude Code configuration could not be verified safely." >&2
    return 1
  fi

  CLAUDE_SETTINGS_RESTORED=1
}

print_claude_restore_summary() {
  if [[ "${CLAUDE_SETTINGS_RESTORED}" != "1" ]]; then
    return
  fi
  echo
  echo "Your original Claude Code settings were restored before the upgrade."
  echo "Reconnect Claude Code through Nexus: nexus claude"
}

ensure_durable_source() {
  if [[ -f "${CLI}" ]]; then
    return
  fi

  local install_dir="${HOME}/.nexus/cli"
  install_progress "Downloading Nexus..."

  if ! command -v git >/dev/null 2>&1; then
    echo "Missing required command: git" >&2
    exit 1
  fi
  # Clone beside the install and swap it in only once it is complete, so a
  # failed download leaves the working CLI (and its launcher) intact.
  local staging="${install_dir}.download"
  rm -rf "${staging}"
  mkdir -p "$(dirname "${install_dir}")"
  if ! git clone --quiet --depth 1 "${SOURCE}" "${staging}" \
    || [[ ! -f "${staging}/packages/setup-cli/bin/nexus.mjs" ]]; then
    rm -rf "${staging}"
    echo "Couldn't download Nexus from ${SOURCE}; your existing install was left in place." >&2
    exit 1
  fi
  rm -rf "${install_dir}"
  mv "${staging}" "${install_dir}"
  CLI="${install_dir}/packages/setup-cli/bin/nexus.mjs"
}

# Install runtime dependencies (cross-keychain, used for secure API-key storage).
# Without it, `import("cross-keychain")` fails at runtime and every
# `configure`/`<harness> on --api-key` aborts with "OS keychain is unavailable."
# Run on every install — including re-installs over an existing CLI — so a
# broken (dep-missing) install is repaired by re-running the installer, not just
# by `nexus update`. Skips dev/peer deps to keep the install lean.
ensure_dependencies() {
  local setup_dir
  setup_dir="$(cd "$(dirname "${CLI}")/.." && pwd)"
  if [[ ! -f "${setup_dir}/package.json" ]]; then
    echo "Nexus source not found; cannot install dependencies." >&2
    exit 1
  fi
  install_progress "Installing dependencies..."
  local npm_loglevel=error
  local npm_stdout="/dev/null"
  if [[ "${NEXUS_INSTALL_VERBOSE:-}" == "1" ]]; then
    npm_loglevel=notice
    npm_stdout="/dev/tty"
  fi
  # npm's "added N packages in Xms" summary prints to stdout regardless of
  # --loglevel, which clutters the install output with a stray line between our
  # `→` steps. Discard stdout (errors still surface on stderr) unless verbose.
  if ! (cd "${setup_dir}" && NEXUS_SKIP_POSTINSTALL_FINALIZE=1 \
    npm install --omit=dev --no-fund --no-audit --loglevel="${npm_loglevel}" 1>"${npm_stdout}"); then
    echo "Failed to install Nexus dependencies." >&2
    exit 1
  fi
}

add_bin_dir_to_path() {
  local bin_dir="${HOME}/.local/bin"
  local path_entry="export PATH=\"${bin_dir}:\$PATH\""
  local shell_config=""

  if [[ -n "${ZSH_VERSION:-}" || "${SHELL:-}" == *"zsh" ]]; then
    shell_config="${HOME}/.zshrc"
  elif [[ -n "${BASH_VERSION:-}" || "${SHELL:-}" == *"bash" ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      shell_config="${HOME}/.bash_profile"
    else
      shell_config="${HOME}/.bashrc"
    fi
  fi

  if [[ -n "${shell_config}" ]]; then
    touch "${shell_config}"
    if ! grep -qxF "${path_entry}" "${shell_config}" 2>/dev/null; then
      echo "${path_entry}" >> "${shell_config}"
      install_note "Added ${bin_dir} to PATH in ${shell_config} (open a new terminal if nexus is not found)."
    fi
  fi
}

# Map a per-shell Node path to one that outlives the shell. fnm puts
# ~/.local/state/fnm_multishells/<id>/bin first on PATH; fnm deletes that
# directory later, so a launcher baked with it stops finding Node. Prefer
# fnm's `default` alias, which tracks `fnm default`. Other paths pass through.
stable_node_bin() {
  local node_bin="$1"
  case "${node_bin}" in
    */fnm_multishells/*)
      local alias_node="${FNM_DIR:-${HOME}/.local/share/fnm}/aliases/default/bin/node"
      if [[ -x "${alias_node}" ]]; then
        printf '%s\n' "${alias_node}"
        return
      fi
      ;;
  esac
  printf '%s\n' "${node_bin}"
}

install_cli_launcher() {
  local bin_dir="${HOME}/.local/bin"
  local launcher_path="${bin_dir}/nexus"

  mkdir -p "${bin_dir}"

  # Resolve an absolute Node path at install time and bake it into the launcher,
  # with a PATH fallback. This keeps the launcher (and the shell env hook's
  # `nexus key export`) working in non-interactive shells where `node`
  # is not on PATH — common in sandboxes, containers, and CI.
  local node_bin
  node_bin="$(stable_node_bin "$(command -v node 2>/dev/null || true)")"

  rm -f "${launcher_path}"

  cat > "${launcher_path}" <<EOF
#!/usr/bin/env bash
# Nexus launcher. Uses the Node binary discovered at install time, falling
# back to PATH lookup, so the shell env hook works without \`node\` on PATH.
NODE_BIN="\${NEXUS_NODE_BIN:-${node_bin}}"
[ -x "\$NODE_BIN" ] || NODE_BIN="\$(command -v node 2>/dev/null)"
if [ -z "\$NODE_BIN" ] || ! [ -x "\$NODE_BIN" ]; then
  echo "nexus: Node.js was not found. Install Node and re-run the Nexus installer." >&2
  exit 1
fi
# Suppress Node's ExperimentalWarning for node:sqlite (Node >= 22).
# --disable-warning landed in Node 21.3.0; older Node would reject the flag.
node_flags=""
if node_major="\$(\$NODE_BIN -p "process.versions.node.split('.')[0]" 2>/dev/null)" && [ "\${node_major}" -ge 22 ] 2>/dev/null; then
  node_flags="--disable-warning=ExperimentalWarning"
fi
exec "\$NODE_BIN" \${node_flags} "${CLI}" "\$@"
EOF
  chmod +x "${launcher_path}"

  install_windows_cmd_shim "${node_bin}"
  add_bin_dir_to_path
}

# Exit 0 when $1 exists and isn't a launcher this CLI wrote. Every launcher
# from every release runs .../packages/setup-cli/bin/{nexus,fireconnect}.mjs.
foreign_launcher() {
  [[ -e "$1" || -L "$1" ]] \
    && ! grep -Eq 'packages[\\/]setup-cli[\\/]bin[\\/](nexus|fireconnect)\.mjs' "$1" 2>/dev/null
}

# Exit 0 when ~/.nexus holds another program's files. Nexus is recognized by
# files only it writes (same rule as the CLI's isNexusDataDir).
foreign_data_dir() {
  [[ -e "${HOME}/.nexus" ]] || return 1
  node - "${HOME}/.nexus" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
let entries = [];
try { entries = fs.readdirSync(dir); } catch { process.exit(0); }
if (entries.length === 0 || entries.includes("key-storage.json") || entries.includes("rename-complete")
  || fs.existsSync(path.join(dir, "cli", "packages", "setup-cli", "bin", "nexus.mjs"))) process.exit(1);
try {
  const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  if (config && typeof config === "object" && typeof config.harnesses === "object") process.exit(1);
} catch {}
process.exit(0);
NODE
}

# Stop before changing anything if another program owns a name Nexus needs.
check_names_are_ours() {
  local file
  for file in "${HOME}/.local/bin/nexus" "${HOME}/.local/bin/nexus.cmd"; do
    if foreign_launcher "${file}"; then
      echo "${file} belongs to another program. Rename or remove it, then rerun the installer." >&2
      return 1
    fi
  done
  if foreign_data_dir; then
    echo "~/.nexus belongs to another program. Rename or remove it, then rerun the installer." >&2
    return 1
  fi
}

# On Windows (Git Bash / MSYS / Cygwin) the bash launcher above only works from
# a POSIX shell. Also drop a `nexus.cmd` shim so native cmd.exe/PowerShell
# can run `nexus`. Best-effort and Windows-only: it needs `cygpath` to
# translate the Unix node/CLI paths to Windows paths, and silently no-ops
# otherwise so it can never break a macOS/Linux install.
install_windows_cmd_shim() {
  local node_bin="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) return 0 ;;
  esac
  command -v cygpath >/dev/null 2>&1 || return 0

  local bin_dir="${HOME}/.local/bin"
  local cmd_path="${bin_dir}/nexus.cmd"
  local node_src node_win cli_win node_flags node_major_for_shim
  node_src="${node_bin:-$(command -v node 2>/dev/null || true)}"
  [[ -n "${node_src}" ]] || return 0
  node_win="$(cygpath -w "${node_src}" 2>/dev/null || true)"
  cli_win="$(cygpath -w "${CLI}" 2>/dev/null || true)"
  [[ -n "${node_win}" && -n "${cli_win}" ]] || return 0

  if node_major_for_shim="$("${node_src}" -p "process.versions.node.split('.')[0]" 2>/dev/null)" \
    && [[ "${node_major_for_shim}" =~ ^[0-9]+$ ]] && (( node_major_for_shim >= 22 )); then
    node_flags="--disable-warning=ExperimentalWarning"
  else
    node_flags=""
  fi

  mkdir -p "${bin_dir}"
  rm -f "${cmd_path}"
  if [[ -n "${node_flags}" ]]; then
    cat > "${cmd_path}" <<EOF
@echo off
"${node_win}" ${node_flags} "${cli_win}" %*
EOF
  else
    cat > "${cmd_path}" <<EOF
@echo off
"${node_win}" "${cli_win}" %*
EOF
  fi
  install_note "Wrote a Windows launcher shim at ${cmd_path}."
}

# Move FireConnect's ~/.fireconnect to ~/.nexus and leave ~/.fireconnect as a
# link to it, so the old launcher and anything else holding that path keep
# working. An existing ~/.nexus (already checked to be ours) is left for the
# CLI's finalize step, which keeps it and sets the old directory aside.
migrate_legacy_data_dir() {
  local legacy="${HOME}/.fireconnect" target="${HOME}/.nexus"
  [[ -d "${legacy}" ]] || return 0
  if [[ -L "${target}" && "$(cd "${target}" 2>/dev/null && pwd -P)" == "$(cd "${legacy}" && pwd -P)" ]]; then
    rm -f "${target}"
  fi
  if [[ -e "${target}" || -L "${target}" ]]; then
    return 0
  fi
  if ! mv "${legacy}" "${target}"; then
    echo "Couldn't move ~/.fireconnect to ~/.nexus. Quit any running harnesses, then rerun the installer." >&2
    return 1
  fi
  # With -e, process.argv[1] is the first argument (no script path).
  if node -e '
const fs = require("node:fs");
const path = require("node:path");
const [legacy, target] = process.argv.slice(1);
if (process.platform === "win32") fs.symlinkSync(target, legacy, "junction");
else fs.symlinkSync(path.basename(target), legacy, "dir");
' "${legacy}" "${target}" 2>/dev/null; then
    install_note "Moved ~/.fireconnect to ~/.nexus."
  else
    install_note "Moved ~/.fireconnect to ~/.nexus, but couldn't leave a link at ~/.fireconnect. Restart any open harness sessions."
  fi
}

main() {
  ensure_node_runtime
  check_names_are_ours
  migrate_legacy_data_dir
  preflight_existing_install
  ensure_durable_source
  ensure_dependencies

  install_progress "Installing CLI..."
  install_cli_launcher

  # Shared with `nexus update`: deps repair, key-storage probe, rebake
  # enabled harness keys, retire the Claude WebSearch MCP, reconcile shell hook.
  # Best-effort — never abort after the launcher is already on disk.
  install_progress "Finalizing install..."
  if ! node "${CLI}" finalize-install; then
    install_note "Post-install finalize skipped (non-fatal). Run: nexus update"
  fi

  local banner_script
  banner_script="$(dirname "${CLI}")/nexus-banner.mjs"
  node "${banner_script}" --context install
  node "${CLI}" help quick
  print_install_notes
  print_claude_restore_summary
}

main "$@"
