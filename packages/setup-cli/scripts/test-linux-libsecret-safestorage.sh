#!/usr/bin/env bash
# Headless Linux integration: libsecret Safe Storage lookup + optional VS Code/Cursor.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYRING_PW="${NEXUS_KEYRING_PW:-nexus}"
BASE="$(mktemp -d)"
export DISPLAY="${DISPLAY:-:99}"
export HOME="$BASE/home"
export XDG_RUNTIME_DIR="$BASE/run"
export XDG_DATA_HOME="$BASE/data"
unset GNOME_KEYRING_CONTROL GNOME_KEYRING_PID
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME"

cleanup() {
  pkill -f "Xvfb $DISPLAY" 2>/dev/null || true
  rm -rf "$BASE"
}
trap cleanup EXIT

Xvfb "$DISPLAY" -screen 0 1280x720x24 >/dev/null 2>&1 &
sleep 1

eval "$(dbus-launch --sh-syntax)"
printf '%s\n' "$KEYRING_PW" | gnome-keyring-daemon --replace --unlock --components=secrets >/dev/null

store_v2() {
  printf '%s' "$2" | secret-tool store --label="$1" \
    xdg:schema chrome_libsecret_os_crypt_password_v2 application "$3"
}

echo "== libsecret application-attribute roundtrip (Code stable) =="
CODE_MASTER_PW="$(openssl rand -base64 16)"
store_v2 'Code Safe Storage' "$CODE_MASTER_PW" code
cd "$ROOT"
node --input-type=module -e "
import { encryptSecret, decryptSecret } from './lib/harnesses/vscode/safestorage.mjs';
const enc = encryptSecret('fw-code-integration', { variant: 'stable' });
const blob = Buffer.from(JSON.parse(enc).data);
if (blob.subarray(0, 3).toString('latin1') !== 'v11') {
  console.error('expected v11 for Code/application=code, got', blob.subarray(0, 3).toString('latin1'));
  process.exit(1);
}
if (decryptSecret(enc, { variant: 'stable' }) !== 'fw-code-integration') {
  console.error('Code stable decrypt roundtrip failed');
  process.exit(1);
}
console.log('OK code application-attribute encrypt/decrypt');
"

echo "== libsecret application-attribute roundtrip (Cursor) =="
MASTER_PW="$(openssl rand -base64 16)"
store_v2 'Cursor Safe Storage' "$MASTER_PW" cursor
cd "$ROOT"
node --input-type=module -e "
import { encryptSecret, decryptSecret } from './lib/harnesses/vscode/safestorage.mjs';
const enc = encryptSecret('fw-integration-test', { variant: 'cursor' });
const blob = Buffer.from(JSON.parse(enc).data);
if (blob.subarray(0, 3).toString('latin1') !== 'v11') {
  console.error('expected v11 ciphertext, got', blob.subarray(0, 3).toString('latin1'));
  process.exit(1);
}
if (decryptSecret(enc, { variant: 'cursor' }) !== 'fw-integration-test') {
  console.error('decrypt roundtrip failed');
  process.exit(1);
}
console.log('OK cursor application-attribute encrypt/decrypt');
"

if [[ -n "${VSCODE_BIN:-}" && -x "$VSCODE_BIN" ]]; then
  echo "== VS Code safeStorage key creation =="
  CODE_USER="$HOME/.config/Code"
  mkdir -p "$CODE_USER"
  timeout 30s "$VSCODE_BIN" \
    --password-store=gnome-libsecret \
    --user-data-dir="$CODE_USER" \
    --extensions-dir="$HOME/.vscode/extensions" \
    --disable-gpu --no-sandbox --wait \
    >/dev/null 2>&1 || true
  if secret-tool lookup xdg:schema chrome_libsecret_os_crypt_password_v2 application code >/dev/null 2>&1 \
    || secret-tool lookup service 'Code Safe Storage' account Code >/dev/null 2>&1; then
    node --input-type=module -e "
import { encryptSecret, decryptSecret } from './lib/harnesses/vscode/safestorage.mjs';
const enc = encryptSecret('fw-vscode-test', { variant: 'stable' });
const blob = Buffer.from(JSON.parse(enc).data);
console.log('vscode prefix', blob.subarray(0, 3).toString('latin1'));
if (decryptSecret(enc, { variant: 'stable' }) !== 'fw-vscode-test') process.exit(1);
console.log('OK vscode encrypt/decrypt with real Safe Storage key');
"
    cd "$ROOT"
  else
    echo "WARN: VS Code did not create a Safe Storage key (skipped decrypt test)"
  fi
fi

if [[ -n "${CURSOR_BIN:-}" && -x "$CURSOR_BIN" ]]; then
  echo "== Cursor safeStorage key creation =="
  CURSOR_USER="$HOME/.config/Cursor"
  mkdir -p "$CURSOR_USER"
  timeout 30s "$CURSOR_BIN" \
    --password-store=gnome-libsecret \
    --user-data-dir="$CURSOR_USER" \
    --disable-gpu --no-sandbox --wait \
    >/dev/null 2>&1 || true
  if secret-tool lookup xdg:schema chrome_libsecret_os_crypt_password_v2 application cursor >/dev/null 2>&1 \
    || secret-tool lookup service 'Cursor Safe Storage' account Cursor >/dev/null 2>&1; then
    node --input-type=module -e "
import { encryptSecret, decryptSecret } from './lib/harnesses/vscode/safestorage.mjs';
const enc = encryptSecret('fw-cursor-test', { variant: 'cursor' });
if (decryptSecret(enc, { variant: 'cursor' }) !== 'fw-cursor-test') process.exit(1);
console.log('OK cursor IDE encrypt/decrypt with real Safe Storage key');
"
    cd "$ROOT"
  else
    echo "WARN: Cursor did not create a Safe Storage key (skipped decrypt test)"
  fi
fi

echo "All linux libsecret safestorage checks passed."
