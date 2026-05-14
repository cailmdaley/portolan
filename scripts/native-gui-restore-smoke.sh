#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="${PORTOLAN_APP_PATH:-$REPO_DIR/src-tauri/target/release/bundle/macos/Portolan.app}"
APP_ID="${PORTOLAN_APP_ID:-com.cailmdaley.portolan}"
APP_DATA_DIR="${PORTOLAN_APP_DATA_DIR:-$HOME/Library/Application Support/$APP_ID}"
WINDOW_STORE="$APP_DATA_DIR/workspace-windows.json"
BACKUP_PATH=""
HAD_STORE=0
HAD_APP_DATA_DIR=0
STARTED_APP=0
PREEXISTING_BACKEND=0
ALLOW_EXTERNAL_BACKEND=0
STRICT_APP_OWNED=0

usage() {
  cat <<'EOF'
Usage: scripts/native-gui-restore-smoke.sh [--app /path/to/Portolan.app] [--allow-external-backend]

Launches the built macOS Portolan.app, seeds native workspace restore state,
checks that the main window and one restored workspace window appear, verifies
/debug-runtime native backend state, then restores the user's app data store.

By default this smoke requires :4004 to be free before launch, so it proves the
built app supervises the bundled backend. Use --allow-external-backend only when
you intentionally want to verify GUI restore against an already-running backend.

Environment:
  PORTOLAN_APP_PATH       Override the app bundle path.
  PORTOLAN_APP_ID         Override the Tauri bundle identifier.
  PORTOLAN_APP_DATA_DIR   Override the app data directory.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP_PATH="${2:-}"
      shift 2
      ;;
    --allow-external-backend)
      ALLOW_EXTERNAL_BACKEND=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[portolan] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[portolan] native-gui-restore-smoke requires $1 on PATH" >&2
    exit 1
  fi
}

osascript_quit() {
  osascript <<'OSA' >/dev/null 2>&1 || true
tell application "Portolan" to quit
OSA
}

restore_store() {
  if [[ "$STARTED_APP" == "1" ]]; then
    osascript_quit
  fi
  if [[ "$HAD_STORE" == "1" && -n "$BACKUP_PATH" && -f "$BACKUP_PATH" ]]; then
    mkdir -p "$APP_DATA_DIR"
    mv "$BACKUP_PATH" "$WINDOW_STORE"
  elif [[ "$HAD_STORE" == "0" ]]; then
    rm -f "$WINDOW_STORE"
    if [[ "$HAD_APP_DATA_DIR" == "0" ]]; then
      rmdir "$APP_DATA_DIR" >/dev/null 2>&1 || true
    fi
  fi
}
trap restore_store EXIT

wait_for_window_count() {
  local expected="$1"
  local deadline=$((SECONDS + 30))
  local count
  while (( SECONDS < deadline )); do
    count="$(osascript <<'OSA' 2>/dev/null || true
tell application "System Events"
  if exists process "Portolan" then
    count windows of process "Portolan"
  else
    0
  end if
end tell
OSA
)"
    count="${count//[[:space:]]/}"
    if [[ "$count" =~ ^[0-9]+$ && "$count" -ge "$expected" ]]; then
      echo "$count"
      return 0
    fi
    sleep 1
  done
  echo "[portolan] timed out waiting for $expected Portolan windows" >&2
  return 1
}

wait_for_backend_shutdown() {
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if ! curl -fsS --max-time 1 http://127.0.0.1:4004/debug-runtime >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

window_titles() {
  osascript <<'OSA' 2>/dev/null || true
tell application "System Events"
  if exists process "Portolan" then
    set output to ""
    repeat with w in windows of process "Portolan"
      set output to output & name of w & linefeed
    end repeat
    output
  end if
end tell
OSA
}

require_command open
require_command osascript
require_command curl

if [[ ! -d "$APP_PATH" ]]; then
  echo "[portolan] built app bundle not found: $APP_PATH" >&2
  echo "[portolan] run npm run tauri:build first, or pass --app /path/to/Portolan.app" >&2
  exit 1
fi

if curl -fsS --max-time 1 http://127.0.0.1:4004/debug-runtime >/dev/null 2>&1; then
  PREEXISTING_BACKEND=1
  if [[ "$ALLOW_EXTERNAL_BACKEND" != "1" ]]; then
    echo "[portolan] existing backend detected on :4004" >&2
    echo "[portolan] stop the dev backend for app-owned validation, or pass --allow-external-backend for GUI-only restore evidence" >&2
    exit 1
  fi
  echo "[portolan] Existing backend detected on :4004; validating GUI restore against the external backend by explicit opt-in"
else
  echo "[portolan] No backend detected on :4004; app is expected to supervise the bundled backend"
  if [[ "$ALLOW_EXTERNAL_BACKEND" != "1" ]]; then
    STRICT_APP_OWNED=1
  fi
fi

if [[ -d "$APP_DATA_DIR" ]]; then
  HAD_APP_DATA_DIR=1
fi
mkdir -p "$APP_DATA_DIR"
if [[ -f "$WINDOW_STORE" ]]; then
  HAD_STORE=1
  BACKUP_PATH="$(mktemp "$APP_DATA_DIR/workspace-windows.backup.XXXXXX")"
  cp "$WINDOW_STORE" "$BACKUP_PATH"
fi

cat >"$WINDOW_STORE" <<'JSON'
[
  {
    "label": "main",
    "routeUrl": "#city=portolan&mode=kanban",
    "title": "Portolan - Kanban",
    "updatedAtUnix": 2000000002
  },
  {
    "label": "workspace-restore-smoke",
    "routeUrl": "#city=portolan&mode=find",
    "title": "Portolan - Find",
    "updatedAtUnix": 2000000001
  }
]
JSON

osascript_quit
echo "[portolan] Launching $APP_PATH with seeded workspace restore state"
open -n "$APP_PATH"
STARTED_APP=1

window_count="$(wait_for_window_count 2)"
titles="$(window_titles)"
echo "[portolan] Observed $window_count Portolan windows"
printf '%s\n' "$titles" | sed '/^$/d;s/^/[portolan] window: /'

if ! printf '%s\n' "$titles" | grep -F "Portolan - Kanban" >/dev/null; then
  echo "[portolan] missing restored main window title: Portolan - Kanban" >&2
  exit 1
fi
if ! printf '%s\n' "$titles" | grep -F "Portolan - Find" >/dev/null; then
  echo "[portolan] missing restored workspace window title: Portolan - Find" >&2
  exit 1
fi

deadline=$((SECONDS + 30))
debug_runtime=""
while (( SECONDS < deadline )); do
  debug_runtime="$(curl -fsS --max-time 2 http://127.0.0.1:4004/debug-runtime 2>/dev/null || true)"
  if [[ -n "$debug_runtime" ]]; then
    break
  fi
  sleep 1
done
if [[ -z "$debug_runtime" ]]; then
  echo "[portolan] backend did not answer /debug-runtime after app launch" >&2
  exit 1
fi

if [[ "$PREEXISTING_BACKEND" == "0" ]] && ! printf '%s\n' "$debug_runtime" | grep -F '"nativeBackend"' >/dev/null; then
  echo "[portolan] app-owned backend answered /debug-runtime without runtime.nativeBackend" >&2
  exit 1
fi

if [[ "$PREEXISTING_BACKEND" == "0" ]]; then
  DEBUG_RUNTIME="$debug_runtime" node <<'NODE'
const payload = JSON.parse(process.env.DEBUG_RUNTIME || '{}');
const nativeBackend = payload.runtime?.nativeBackend;
const expected = {
  enabled: true,
  launchKind: 'node-dist-resource',
  supervised: true,
};
for (const [key, value] of Object.entries(expected)) {
  if (nativeBackend?.[key] !== value) {
    console.error(
      `[portolan] app-owned backend expected runtime.nativeBackend.${key}=${JSON.stringify(value)}; got ${JSON.stringify(nativeBackend?.[key])}`,
    );
    process.exit(1);
  }
}
NODE
fi

if [[ "$STRICT_APP_OWNED" == "1" ]]; then
  echo "[portolan] Verifying app-owned backend shutdown after quit"
  osascript_quit
  if ! wait_for_backend_shutdown; then
    echo "[portolan] backend on :4004 still responding after app quit" >&2
    exit 1
  fi
  echo "[portolan] App-owned backend stopped cleanly after quit"
fi

echo "[portolan] Built app launch/restore smoke passed"
