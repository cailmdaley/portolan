#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_APP_PATH="$REPO_DIR/target/release/bundle/macos/Portolan.app"
LEGACY_APP_PATH="$REPO_DIR/src-tauri/target/release/bundle/macos/Portolan.app"
APP_PATH="${PORTOLAN_APP_PATH:-$DEFAULT_APP_PATH}"
APP_ID="${PORTOLAN_APP_ID:-com.cailmdaley.portolan}"
APP_DATA_DIR="${PORTOLAN_APP_DATA_DIR:-$HOME/Library/Application Support/$APP_ID}"
APP_NAME="${PORTOLAN_APP_NAME:-}"
WINDOW_STORE="$APP_DATA_DIR/workspace-windows.json"
RESTORE_MAIN_LABEL="main"
RESTORE_MAIN_ROUTE="#city=portolan&mode=kanban"
RESTORE_MAIN_TITLE="Kanban · portolan · Portolan"
RESTORE_MAIN_MAP_ROUTE="#city=portolan"
RESTORE_MAIN_MAP_TITLE="Portolan"
RESTORE_MAIN_SEEDED_UPDATED_AT=1700000002
RESTORE_WORKSPACE_LABEL="workspace-restore-smoke"
RESTORE_WORKSPACE_ROUTE="#city=portolan&mode=find"
RESTORE_WORKSPACE_TITLE="Find · portolan · Portolan"
RESTORE_WORKSPACE_SEEDED_UPDATED_AT=1700000001
BACKUP_PATH=""
HAD_STORE=0
HAD_APP_DATA_DIR=0
STARTED_APP=0
PREEXISTING_BACKEND=0
ALLOW_EXTERNAL_BACKEND=0
STRICT_APP_OWNED=0
MANAGE_DEV_STACK=0
DEV_STACK_WAS_RUNNING=0
WINDOW_DEBUG_RUNTIME_JSON=""
SMOKE_DIR=""
NATIVE_STATUS_PATH=""
NATIVE_STATUS_JSON=""

usage() {
  cat <<'EOF'
Usage: scripts/native-gui-restore-smoke.sh [--app /path/to/Portolan.app] [--allow-external-backend] [--manage-dev-stack]

Launches the built macOS Portolan.app, seeds native workspace restore state,
checks that the main window and one restored workspace window appear, verifies
/debug-runtime/native runtime lifecycle, then restores the user's app data store.

The smoke launches the built app executable with PORTOLAN_NATIVE_STATUS_PATH
so it can compare the app's native_status snapshot with /debug-runtime. If
PORTOLAN_DEBUG_RUNTIME_COMMAND is set, that command can additionally print
window.debugRuntime() JSON and the smoke will assert the frontend-computed
nativeLifecycle diagnostic directly.

By default this smoke requires :4004 to be free before launch, so it proves the
built app supervises the bundled backend. Use --allow-external-backend only when
you intentionally want to verify GUI restore against an already-running backend.
Use --manage-dev-stack to temporarily stop the shared portolan-dev tmux stack
for strict app-owned validation, then restart it during cleanup.

Environment:
  PORTOLAN_APP_PATH       Override the app bundle path.
  PORTOLAN_APP_ID         Override the Tauri bundle identifier.
  PORTOLAN_APP_DATA_DIR   Override the app data directory.
  PORTOLAN_APP_NAME       Override the app/process name for AppleScript targeting.
  PORTOLAN_DEBUG_RUNTIME_COMMAND
                          Optional shell command that prints window.debugRuntime().
                          If set, it is used for frontend lifecycle diagnostics.
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
    --manage-dev-stack)
      MANAGE_DEV_STACK=1
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
  osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
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
  if [[ -n "$SMOKE_DIR" ]]; then
    rm -rf "$SMOKE_DIR"
  fi
  if [[ "$DEV_STACK_WAS_RUNNING" == "1" ]]; then
    echo "[portolan] Restarting shared dev stack"
    "$REPO_DIR/dev.sh" restart >/dev/null
  fi
}
trap restore_store EXIT

has_dev_stack() {
  tmux has-session -t "=portolan-dev" 2>/dev/null
}

stop_dev_stack_for_strict_smoke() {
  if [[ "$MANAGE_DEV_STACK" != "1" ]]; then
    return 0
  fi
  if [[ "$ALLOW_EXTERNAL_BACKEND" == "1" ]]; then
    echo "[portolan] --manage-dev-stack is only used for strict app-owned validation; ignoring because --allow-external-backend was passed"
    return 0
  fi
  require_command tmux
  if has_dev_stack; then
    DEV_STACK_WAS_RUNNING=1
    echo "[portolan] Stopping shared dev stack for strict app-owned validation"
    "$REPO_DIR/dev.sh" kill >/dev/null
  fi
}

wait_for_window_count() {
  local expected="$1"
  local deadline=$((SECONDS + 30))
  local count
  while (( SECONDS < deadline )); do
    count="$(osascript <<OSA 2>/dev/null || true
tell application "System Events"
  if exists process "${APP_NAME}" then
    count windows of process "${APP_NAME}"
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

backend_runtime_json() {
  curl -fsS --max-time 1 http://127.0.0.1:4004/debug-runtime 2>/dev/null || true
}

collect_frontend_debug_runtime() {
  if [[ -z "${PORTOLAN_DEBUG_RUNTIME_COMMAND:-}" ]]; then
    return 1
  fi

  echo "[portolan] Probing frontend window.debugRuntime() via PORTOLAN_DEBUG_RUNTIME_COMMAND"
  if ! WINDOW_DEBUG_RUNTIME_JSON="$(sh -lc "$PORTOLAN_DEBUG_RUNTIME_COMMAND" 2>/dev/null || true)"; then
    return 1
  fi

  if [[ -z "$WINDOW_DEBUG_RUNTIME_JSON" ]]; then
    return 1
  fi

  return 0
}

wait_for_native_status() {
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if [[ -s "$NATIVE_STATUS_PATH" ]]; then
      cat "$NATIVE_STATUS_PATH"
      return 0
    fi
    sleep 1
  done
  echo "[portolan] timed out waiting for native status export" >&2
  return 1
}

wait_for_native_status_change() {
  local previous="$1"
  local deadline=$((SECONDS + 30))
  local current
  while (( SECONDS < deadline )); do
    if [[ -s "$NATIVE_STATUS_PATH" ]]; then
      current="$(cat "$NATIVE_STATUS_PATH" 2>/dev/null || true)"
      if [[ -n "$current" && "$current" != "$previous" ]]; then
        printf '%s' "$current"
        return 0
      fi
    fi
    sleep 1
  done
  echo "[portolan] timed out waiting for native status export to update" >&2
  if [[ -f "$NATIVE_STATUS_PATH" ]]; then
    echo "[portolan] latest native status export:" >&2
    sed 's/^/[portolan] native-status: /' "$NATIVE_STATUS_PATH" >&2
  fi
  return 1
}

wait_for_workspace_store_rewrite() {
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if [[ -s "$WINDOW_STORE" ]] && WINDOW_STORE_JSON="$(cat "$WINDOW_STORE" 2>/dev/null || true)" \
      RESTORE_MAIN_LABEL="$RESTORE_MAIN_LABEL" \
      RESTORE_MAIN_ROUTE="$RESTORE_MAIN_ROUTE" \
      RESTORE_MAIN_TITLE="$RESTORE_MAIN_TITLE" \
      RESTORE_WORKSPACE_LABEL="$RESTORE_WORKSPACE_LABEL" \
      RESTORE_WORKSPACE_ROUTE="$RESTORE_WORKSPACE_ROUTE" \
      RESTORE_WORKSPACE_TITLE="$RESTORE_WORKSPACE_TITLE" \
      RESTORE_WORKSPACE_SEEDED_UPDATED_AT="$RESTORE_WORKSPACE_SEEDED_UPDATED_AT" \
      node --input-type=module >/dev/null 2>&1 <<'NODE'
const recent = JSON.parse(process.env.WINDOW_STORE_JSON || '[]');
if (!Array.isArray(recent)) process.exit(1);

const expectedByLabel = new Map([
  [process.env.RESTORE_MAIN_LABEL, {
    mode: 'kanban',
    title: process.env.RESTORE_MAIN_TITLE,
    requireAdvance: false,
    minUpdatedAt: 0,
  }],
  [process.env.RESTORE_WORKSPACE_LABEL, {
    mode: 'find',
    title: process.env.RESTORE_WORKSPACE_TITLE,
    requireAdvance: true,
    minUpdatedAt: Number(process.env.RESTORE_WORKSPACE_SEEDED_UPDATED_AT || '0'),
  }],
]);

if (recent.length !== expectedByLabel.size) process.exit(1);
const byLabel = new Map();
for (const entry of recent) {
  if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string') process.exit(1);
  if (byLabel.has(entry.label)) process.exit(1);
  byLabel.set(entry.label, entry);
}
if (byLabel.size !== expectedByLabel.size) process.exit(1);

for (const [label, expected] of expectedByLabel) {
  const entry = byLabel.get(label);
  if (!entry) process.exit(1);
  if (typeof entry.routeUrl !== 'string' || !entry.routeUrl.startsWith('#')) process.exit(1);
  const params = new URLSearchParams(entry.routeUrl.slice(1));
  if (params.get('mode') !== expected.mode) process.exit(1);
  if (!params.get('city')) process.exit(1);
  if (entry.title !== expected.title) process.exit(1);
  if (typeof entry.updatedAtUnix !== 'number' || !Number.isFinite(entry.updatedAtUnix)) {
    process.exit(1);
  }
  if (expected.requireAdvance && entry.updatedAtUnix <= expected.minUpdatedAt) {
    process.exit(1);
  }
}
NODE
    then
      echo "[portolan] workspace store replay preserved saved labels"
      return 0
    fi
    sleep 1
  done

  echo "[portolan] timed out waiting for workspace store replay to preserve saved labels" >&2
  if [[ -f "$WINDOW_STORE" ]]; then
    echo "[portolan] latest workspace store contents:" >&2
    sed 's/^/[portolan] workspace-store: /' "$WINDOW_STORE" >&2
  fi
  return 1
}

wait_for_main_map_workspace_store() {
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if [[ -s "$WINDOW_STORE" ]] && WINDOW_STORE_JSON="$(cat "$WINDOW_STORE" 2>/dev/null || true)" \
      RESTORE_MAIN_LABEL="$RESTORE_MAIN_LABEL" \
      RESTORE_MAIN_MAP_TITLE="$RESTORE_MAIN_MAP_TITLE" \
      RESTORE_MAIN_SEEDED_UPDATED_AT="$RESTORE_MAIN_SEEDED_UPDATED_AT" \
      node --input-type=module >/dev/null 2>&1 <<'NODE'
const recent = JSON.parse(process.env.WINDOW_STORE_JSON || '[]');
if (!Array.isArray(recent)) process.exit(1);
const parseRoute = (routeUrl) => {
  if (typeof routeUrl !== 'string' || !routeUrl.startsWith('#')) return null;
  const params = new URLSearchParams(routeUrl.slice(1));
  const city = params.get('city');
  return city ? { city, mode: params.get('mode') } : null;
};
const main = recent.find(entry => entry && typeof entry === 'object' && entry.label === process.env.RESTORE_MAIN_LABEL);
if (!main) process.exit(1);
const mainRoute = parseRoute(main.routeUrl);
if (!mainRoute || mainRoute.mode !== null) process.exit(1);
if (main.title !== process.env.RESTORE_MAIN_MAP_TITLE) process.exit(1);
if (typeof main.updatedAtUnix !== 'number' || !Number.isFinite(main.updatedAtUnix)) process.exit(1);
if (main.updatedAtUnix <= Number(process.env.RESTORE_MAIN_SEEDED_UPDATED_AT || '0')) process.exit(1);
NODE
    then
      echo "[portolan] main workspace recorded map route after closing vellum"
      return 0
    fi
    sleep 1
  done

  echo "[portolan] timed out waiting for main workspace to record map route" >&2
  if [[ -f "$WINDOW_STORE" ]]; then
    echo "[portolan] latest workspace store contents:" >&2
    sed 's/^/[portolan] workspace-store: /' "$WINDOW_STORE" >&2
  fi
  return 1
}

wait_for_map_duplicate_workspace_store() {
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if [[ -s "$WINDOW_STORE" ]] && WINDOW_STORE_JSON="$(cat "$WINDOW_STORE" 2>/dev/null || true)" \
      RESTORE_MAIN_LABEL="$RESTORE_MAIN_LABEL" \
      RESTORE_MAIN_MAP_TITLE="$RESTORE_MAIN_MAP_TITLE" \
      RESTORE_MAIN_SEEDED_UPDATED_AT="$RESTORE_MAIN_SEEDED_UPDATED_AT" \
      RESTORE_WORKSPACE_LABEL="$RESTORE_WORKSPACE_LABEL" \
      RESTORE_WORKSPACE_SEEDED_UPDATED_AT="$RESTORE_WORKSPACE_SEEDED_UPDATED_AT" \
      node --input-type=module >/dev/null 2>&1 <<'NODE'
const recent = JSON.parse(process.env.WINDOW_STORE_JSON || '[]');
if (!Array.isArray(recent) || recent.length !== 3) process.exit(1);

const titleMatches = (title, token) => typeof title === 'string' && title.includes(token) && title.includes('Portolan');
const parseRoute = (routeUrl) => {
  if (typeof routeUrl !== 'string' || !routeUrl.startsWith('#')) return null;
  const params = new URLSearchParams(routeUrl.slice(1));
  const city = params.get('city');
  return city ? { city, mode: params.get('mode') } : null;
};
const byLabel = new Map();
for (const entry of recent) {
  if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string') process.exit(1);
  if (byLabel.has(entry.label)) process.exit(1);
  byLabel.set(entry.label, entry);
}
const main = byLabel.get(process.env.RESTORE_MAIN_LABEL);
if (!main) process.exit(1);
const mainRoute = parseRoute(main.routeUrl);
if (!mainRoute || mainRoute.mode !== null) process.exit(1);
if (main.title !== process.env.RESTORE_MAIN_MAP_TITLE) process.exit(1);
if (typeof main.updatedAtUnix !== 'number' || !Number.isFinite(main.updatedAtUnix)) process.exit(1);
if (main.updatedAtUnix <= Number(process.env.RESTORE_MAIN_SEEDED_UPDATED_AT || '0')) process.exit(1);

const workspace = byLabel.get(process.env.RESTORE_WORKSPACE_LABEL);
if (!workspace) process.exit(1);
const workspaceRoute = parseRoute(workspace.routeUrl);
if (!workspaceRoute || workspaceRoute.mode !== 'find') process.exit(1);
if (!titleMatches(workspace.title, 'Find')) process.exit(1);
if (typeof workspace.updatedAtUnix !== 'number' || !Number.isFinite(workspace.updatedAtUnix)) process.exit(1);
if (workspace.updatedAtUnix <= Number(process.env.RESTORE_WORKSPACE_SEEDED_UPDATED_AT || '0')) process.exit(1);

const duplicates = recent.filter(entry => ![process.env.RESTORE_MAIN_LABEL, process.env.RESTORE_WORKSPACE_LABEL].includes(entry.label));
if (duplicates.length !== 1) process.exit(1);
const duplicate = duplicates[0];
const duplicateRoute = parseRoute(duplicate.routeUrl);
if (!duplicateRoute || duplicateRoute.mode !== null || duplicateRoute.city !== mainRoute.city) process.exit(1);
if (duplicate.title !== process.env.RESTORE_MAIN_MAP_TITLE) process.exit(1);
if (typeof duplicate.updatedAtUnix !== 'number' || !Number.isFinite(duplicate.updatedAtUnix)) process.exit(1);
if (duplicate.updatedAtUnix <= Number(process.env.RESTORE_MAIN_SEEDED_UPDATED_AT || '0')) process.exit(1);
NODE
    then
      echo "[portolan] workspace store recorded duplicated map route"
      return 0
    fi
    sleep 1
  done

  echo "[portolan] timed out waiting for duplicated map entry in store" >&2
  if [[ -f "$WINDOW_STORE" ]]; then
    echo "[portolan] latest workspace store contents:" >&2
    sed 's/^/[portolan] workspace-store: /' "$WINDOW_STORE" >&2
  fi
  return 1
}

wait_for_duplicate_workspace_store() {
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if [[ -s "$WINDOW_STORE" ]] && WINDOW_STORE_JSON="$(cat "$WINDOW_STORE" 2>/dev/null || true)" \
      RESTORE_MAIN_LABEL="$RESTORE_MAIN_LABEL" \
      RESTORE_MAIN_MAP_TITLE="$RESTORE_MAIN_MAP_TITLE" \
      RESTORE_MAIN_SEEDED_UPDATED_AT="$RESTORE_MAIN_SEEDED_UPDATED_AT" \
      RESTORE_WORKSPACE_LABEL="$RESTORE_WORKSPACE_LABEL" \
      RESTORE_WORKSPACE_SEEDED_UPDATED_AT="$RESTORE_WORKSPACE_SEEDED_UPDATED_AT" \
      node --input-type=module >/dev/null 2>&1 <<'NODE'
const recent = JSON.parse(process.env.WINDOW_STORE_JSON || '[]');
if (!Array.isArray(recent) || recent.length !== 4) process.exit(1);

const titleMatches = (title, token) => typeof title === 'string' && title.includes(token) && title.includes('Portolan');
const parseRoute = (routeUrl) => {
  if (typeof routeUrl !== 'string' || !routeUrl.startsWith('#')) return null;
  const params = new URLSearchParams(routeUrl.slice(1));
  const city = params.get('city');
  return city ? { city, mode: params.get('mode') } : null;
};
const byLabel = new Map();
for (const entry of recent) {
  if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string') process.exit(1);
  if (byLabel.has(entry.label)) process.exit(1);
  byLabel.set(entry.label, entry);
}
const main = byLabel.get(process.env.RESTORE_MAIN_LABEL);
if (!main) process.exit(1);
const mainRoute = parseRoute(main.routeUrl);
if (!mainRoute || mainRoute.mode !== null) process.exit(1);
if (main.title !== process.env.RESTORE_MAIN_MAP_TITLE) process.exit(1);
if (typeof main.updatedAtUnix !== 'number' || !Number.isFinite(main.updatedAtUnix)) process.exit(1);
if (main.updatedAtUnix <= Number(process.env.RESTORE_MAIN_SEEDED_UPDATED_AT || '0')) process.exit(1);

const workspace = byLabel.get(process.env.RESTORE_WORKSPACE_LABEL);
if (!workspace) process.exit(1);
const workspaceRoute = parseRoute(workspace.routeUrl);
if (!workspaceRoute || workspaceRoute.mode !== 'find') process.exit(1);
if (!titleMatches(workspace.title, 'Find')) process.exit(1);
if (typeof workspace.updatedAtUnix !== 'number' || !Number.isFinite(workspace.updatedAtUnix)) process.exit(1);
if (workspace.updatedAtUnix <= Number(process.env.RESTORE_WORKSPACE_SEEDED_UPDATED_AT || '0')) process.exit(1);

const duplicates = recent.filter(entry => ![process.env.RESTORE_MAIN_LABEL, process.env.RESTORE_WORKSPACE_LABEL].includes(entry.label));
if (duplicates.length !== 2) process.exit(1);
const mapDuplicates = duplicates.filter(entry => {
  const route = parseRoute(entry.routeUrl);
  return route && route.mode === null && route.city === mainRoute.city;
});
const findDuplicates = duplicates.filter(entry => {
  const route = parseRoute(entry.routeUrl);
  return route && route.mode === 'find' && route.city === workspaceRoute.city;
});
if (mapDuplicates.length !== 1 || findDuplicates.length !== 1) process.exit(1);
const mapDuplicate = mapDuplicates[0];
const findDuplicate = findDuplicates[0];
if (mapDuplicate.title !== process.env.RESTORE_MAIN_MAP_TITLE) process.exit(1);
if (typeof mapDuplicate.updatedAtUnix !== 'number' || !Number.isFinite(mapDuplicate.updatedAtUnix)) process.exit(1);
if (mapDuplicate.updatedAtUnix <= Number(process.env.RESTORE_MAIN_SEEDED_UPDATED_AT || '0')) process.exit(1);
if (!titleMatches(findDuplicate.title, 'Find')) process.exit(1);
if (typeof findDuplicate.updatedAtUnix !== 'number' || !Number.isFinite(findDuplicate.updatedAtUnix)) process.exit(1);
if (findDuplicate.updatedAtUnix <= Number(process.env.RESTORE_WORKSPACE_SEEDED_UPDATED_AT || '0')) process.exit(1);
NODE
    then
      echo "[portolan] workspace store recorded duplicated map + find routes"
      return 0
    fi
    sleep 1
  done

  echo "[portolan] timed out waiting for duplicated map + find entries in store" >&2
  if [[ -f "$WINDOW_STORE" ]]; then
    echo "[portolan] latest workspace store contents:" >&2
    sed 's/^/[portolan] workspace-store: /' "$WINDOW_STORE" >&2
  fi
  return 1
}

window_titles() {
  osascript <<OSA 2>/dev/null || true
tell application "System Events"
  if exists process "${APP_NAME}" then
    set output to ""
    repeat with w in windows of process "${APP_NAME}"
      set output to output & name of w & linefeed
    end repeat
    output
  end if
end tell
OSA
}

wait_for_window_title_presence() {
  local title="$1"
  local deadline=$((SECONDS + 30))
  local titles
  while (( SECONDS < deadline )); do
    titles="$(window_titles)"
    if printf '%s\n' "$titles" | grep -Fqx "$title"; then
      return 0
    fi
    sleep 1
  done
  echo "[portolan] timed out waiting for window title: $title" >&2
  printf '%s\n' "$titles" | sed '/^$/d;s/^/[portolan] window: /' >&2
  return 1
}

wait_for_window_title_token() {
  local token="$1"
  local deadline=$((SECONDS + 30))
  local titles
  local match
  while (( SECONDS < deadline )); do
    titles="$(window_titles)"
    match="$(printf '%s\n' "$titles" | grep -F "$token" | head -n 1 || true)"
    if [[ -n "$match" ]]; then
      printf '%s\n' "$match"
      return 0
    fi
    sleep 1
  done
  echo "[portolan] timed out waiting for a window title containing: $token" >&2
  printf '%s\n' "$titles" | sed '/^$/d;s/^/[portolan] window: /' >&2
  return 1
}

wait_for_window_title_token_absence() {
  local token="$1"
  local deadline=$((SECONDS + 30))
  local titles
  while (( SECONDS < deadline )); do
    titles="$(window_titles)"
    if ! printf '%s\n' "$titles" | grep -Fq "$token"; then
      return 0
    fi
    sleep 1
  done
  echo "[portolan] timed out waiting for stale window-title token to disappear: $token" >&2
  printf '%s\n' "$titles" | sed '/^$/d;s/^/[portolan] window: /' >&2
  return 1
}

focus_window_title() {
  local title="$1"
  osascript <<OSA >/dev/null 2>&1
tell application "${APP_NAME}" to activate
tell application "System Events"
  tell process "${APP_NAME}"
    set frontmost to true
    perform action "AXRaise" of window "${title}"
  end tell
end tell
OSA
}

click_close_workspace_button() {
  local title="$1"
  osascript <<OSA >/dev/null 2>&1
tell application "${APP_NAME}" to activate
delay 0.2
tell application "System Events"
  tell process "${APP_NAME}"
    set frontmost to true
    perform action "AXRaise" of window "${title}"
    repeat with attempt from 1 to 30
      try
        set w to window "${title}"
        set g1 to item 1 of groups of w
        set g2 to item 1 of groups of g1
        set sa to item 1 of scroll areas of g2
        set webarea to item 1 of UI elements of sa
        set workspaceGroup to item 1 of groups of webarea
        click button "Close vellum workspace (Esc)" of workspaceGroup
        return
      on error
        delay 1
      end try
    end repeat
    error "close button not found in ${title}"
  end tell
end tell
OSA
}

duplicate_focused_window_via_shortcut() {
  osascript <<OSA >/dev/null 2>&1
tell application "${APP_NAME}" to activate
delay 0.2
tell application "System Events"
  tell process "${APP_NAME}"
    set frontmost to true
  end tell
  keystroke "n" using {command down}
end tell
OSA
}

click_duplicate_workspace_button() {
  local title="$1"
  osascript <<OSA >/dev/null 2>&1
tell application "${APP_NAME}" to activate
delay 0.2
tell application "System Events"
  tell process "${APP_NAME}"
    set frontmost to true
    perform action "AXRaise" of window "${title}"
    repeat with attempt from 1 to 30
      try
        set w to window "${title}"
        set g1 to item 1 of groups of w
        set g2 to item 1 of groups of g1
        set sa to item 1 of scroll areas of g2
        set webarea to item 1 of UI elements of sa
        set workspaceGroup to item 1 of groups of webarea
        click button "Open this workspace in a new window" of workspaceGroup
        return
      on error
        delay 1
      end try
    end repeat
    error "duplicate button not found in ${title}"
  end tell
end tell
OSA
}

require_command open
require_command osascript
require_command curl
require_command node
require_command /usr/libexec/PlistBuddy

stop_dev_stack_for_strict_smoke

if [[ -z "${PORTOLAN_APP_PATH:-}" && ! -d "$APP_PATH" && -d "$LEGACY_APP_PATH" ]]; then
  APP_PATH="$LEGACY_APP_PATH"
  echo "[portolan] Falling back to legacy bundle path: $APP_PATH"
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "[portolan] built app bundle not found: $APP_PATH" >&2
  echo "[portolan] run bun run tauri:build first, or pass --app /path/to/Portolan.app" >&2
  exit 1
fi
APP_EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
if [[ -z "$APP_EXECUTABLE_NAME" ]]; then
  echo "[portolan] could not read CFBundleExecutable from $APP_PATH/Contents/Info.plist" >&2
  exit 1
fi
APP_NAME="${APP_NAME:-$(
  /usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$APP_PATH/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$APP_PATH/Contents/Info.plist" 2>/dev/null || true
)}"
APP_NAME="${APP_NAME:-Portolan}"
APP_EXECUTABLE="$APP_PATH/Contents/MacOS/$APP_EXECUTABLE_NAME"
if [[ ! -x "$APP_EXECUTABLE" ]]; then
  echo "[portolan] app executable not found: $APP_EXECUTABLE" >&2
  exit 1
fi

if [[ "$ALLOW_EXTERNAL_BACKEND" != "1" && "$MANAGE_DEV_STACK" == "1" ]]; then
  echo "[portolan] Waiting for shared dev stack shutdown to free :4004"
  if ! wait_for_backend_shutdown; then
    echo "[portolan] existing backend still responding on :4004 after dev stack shutdown" >&2
    echo "[portolan] --manage-dev-stack is only best-effort for strict validation; rerun with --allow-external-backend if this is intentional" >&2
    exit 1
  fi
fi

PREEXISTING_BACKEND_RUNTIME="$(backend_runtime_json)"
if [[ -n "$PREEXISTING_BACKEND_RUNTIME" ]]; then
  PREEXISTING_BACKEND=1
  if [[ "$ALLOW_EXTERNAL_BACKEND" != "1" ]]; then
    echo "[portolan] existing backend detected on :4004" >&2
    echo "[portolan] stop the dev backend for app-owned validation, or pass --allow-external-backend for GUI-only evidence" >&2
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

cat >"$WINDOW_STORE" <<JSON
[
  {
    "label": "$RESTORE_MAIN_LABEL",
    "routeUrl": "$RESTORE_MAIN_ROUTE",
    "title": "$RESTORE_MAIN_TITLE",
    "updatedAtUnix": $RESTORE_MAIN_SEEDED_UPDATED_AT
  },
  {
    "label": "$RESTORE_WORKSPACE_LABEL",
    "routeUrl": "$RESTORE_WORKSPACE_ROUTE",
    "title": "$RESTORE_WORKSPACE_TITLE",
    "updatedAtUnix": $RESTORE_WORKSPACE_SEEDED_UPDATED_AT
  }
]
JSON

osascript_quit
echo "[portolan] Launching $APP_PATH with seeded workspace restore state"
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/portolan-native-gui-smoke.XXXXXX")"
NATIVE_STATUS_PATH="$SMOKE_DIR/native-status.json"
PORTOLAN_NATIVE_STATUS_PATH="$NATIVE_STATUS_PATH" "$APP_EXECUTABLE" >/dev/null 2>&1 &
STARTED_APP=1

window_count="$(wait_for_window_count 2)"
titles="$(window_titles)"
echo "[portolan] Observed $window_count Portolan windows"
printf '%s\n' "$titles" | sed '/^$/d;s/^/[portolan] window: /'

if ! wait_for_window_title_presence "$RESTORE_MAIN_TITLE"; then
  echo "[portolan] main workspace window never exposed the canonical restore title: $RESTORE_MAIN_TITLE" >&2
  exit 1
fi
if ! wait_for_window_title_presence "$RESTORE_WORKSPACE_TITLE"; then
  echo "[portolan] secondary workspace window never exposed the canonical restore title: $RESTORE_WORKSPACE_TITLE" >&2
  exit 1
fi
main_window_title="$(wait_for_window_title_token 'Kanban')"
workspace_window_title="$(wait_for_window_title_token 'Find')"
echo "[portolan] Resolved main workspace window title: $main_window_title"
echo "[portolan] Resolved secondary workspace window title: $workspace_window_title"

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

collect_frontend_debug_runtime || true
NATIVE_STATUS_JSON="$(wait_for_native_status)"
wait_for_workspace_store_rewrite
main_window_title="$(wait_for_window_title_token 'Kanban')"

echo "[portolan] Closing ${main_window_title} back to the map via close chrome"
if ! click_close_workspace_button "$main_window_title"; then
  echo "[portolan] failed to click close chrome in restored main workspace window: $main_window_title" >&2
  exit 1
fi
wait_for_main_map_workspace_store
NATIVE_STATUS_JSON="$(wait_for_native_status_change "$NATIVE_STATUS_JSON")"

titles="$(window_titles)"
echo "[portolan] Observed Portolan windows after closing the main workspace"
printf '%s\n' "$titles" | sed '/^$/d;s/^/[portolan] window: /'
if ! wait_for_window_title_presence "$RESTORE_MAIN_MAP_TITLE"; then
  echo "[portolan] main window title never updated to the post-close map title: $RESTORE_MAIN_MAP_TITLE" >&2
  exit 1
fi
if ! wait_for_window_title_token_absence 'Kanban'; then
  echo "[portolan] stale Kanban-flavored window title persisted after the main workspace closed back to the map" >&2
  exit 1
fi

echo "[portolan] Duplicating the frontmost map route via Cmd+N"
if ! duplicate_focused_window_via_shortcut; then
  echo "[portolan] failed to duplicate the frontmost map route via Cmd+N" >&2
  exit 1
fi
window_count="$(wait_for_window_count 3)"
titles="$(window_titles)"
echo "[portolan] Observed $window_count Portolan windows after duplicating the map route"
printf '%s\n' "$titles" | sed '/^$/d;s/^/[portolan] window: /'
if [[ "$(printf '%s\n' "$titles" | grep -Fxc "$RESTORE_MAIN_MAP_TITLE")" -lt 2 ]]; then
  echo "[portolan] expected both map windows to expose the map title after Cmd+N: $RESTORE_MAIN_MAP_TITLE" >&2
  exit 1
fi
wait_for_map_duplicate_workspace_store
NATIVE_STATUS_JSON="$(wait_for_native_status_change "$NATIVE_STATUS_JSON")"

workspace_window_title="$(wait_for_window_title_token 'Find')"
echo "[portolan] Duplicating ${workspace_window_title} via duplicate-window chrome"
if ! focus_window_title "$workspace_window_title"; then
  echo "[portolan] failed to focus restored workspace window: $workspace_window_title" >&2
  exit 1
fi
if ! click_duplicate_workspace_button "$workspace_window_title"; then
  echo "[portolan] failed to click duplicate-window button in ${workspace_window_title}" >&2
  exit 1
fi

window_count="$(wait_for_window_count 4)"
titles="$(window_titles)"
echo "[portolan] Observed $window_count Portolan windows after map + workspace duplication"
printf '%s\n' "$titles" | sed '/^$/d;s/^/[portolan] window: /'
if [[ "$(printf '%s\n' "$titles" | grep -Fxc "$RESTORE_WORKSPACE_TITLE")" -lt 2 ]]; then
  echo "[portolan] expected two exact Find workspace titles after duplicate-window chrome: $RESTORE_WORKSPACE_TITLE" >&2
  exit 1
fi
wait_for_duplicate_workspace_store
NATIVE_STATUS_JSON="$(wait_for_native_status_change "$NATIVE_STATUS_JSON")"

DEBUG_RUNTIME="$debug_runtime" WINDOW_DEBUG_RUNTIME_JSON="$WINDOW_DEBUG_RUNTIME_JSON" NATIVE_STATUS_JSON="$NATIVE_STATUS_JSON" \
  STRICT_APP_OWNED="$STRICT_APP_OWNED" ALLOW_EXTERNAL_BACKEND="$ALLOW_EXTERNAL_BACKEND" \
  RESTORE_MAIN_LABEL="$RESTORE_MAIN_LABEL" RESTORE_MAIN_ROUTE="$RESTORE_MAIN_ROUTE" RESTORE_MAIN_TITLE="$RESTORE_MAIN_TITLE" \
  RESTORE_MAIN_MAP_ROUTE="$RESTORE_MAIN_MAP_ROUTE" RESTORE_MAIN_MAP_TITLE="$RESTORE_MAIN_MAP_TITLE" RESTORE_MAIN_SEEDED_UPDATED_AT="$RESTORE_MAIN_SEEDED_UPDATED_AT" \
  RESTORE_WORKSPACE_LABEL="$RESTORE_WORKSPACE_LABEL" RESTORE_WORKSPACE_ROUTE="$RESTORE_WORKSPACE_ROUTE" RESTORE_WORKSPACE_TITLE="$RESTORE_WORKSPACE_TITLE" \
  RESTORE_WORKSPACE_SEEDED_UPDATED_AT="$RESTORE_WORKSPACE_SEEDED_UPDATED_AT" \
  node --input-type=module <<'NODE'
const debugRuntime = process.env.DEBUG_RUNTIME || '{}';
const frontendRuntime = process.env.WINDOW_DEBUG_RUNTIME_JSON || '';
const nativeStatusRuntime = process.env.NATIVE_STATUS_JSON || '{}';
const strictOwned = process.env.STRICT_APP_OWNED === '1';
const allowExternal = process.env.ALLOW_EXTERNAL_BACKEND === '1';

let payload;
let front;
let native;

try {
  payload = JSON.parse(debugRuntime);
} catch (error) {
  console.error('[portolan] failed to parse /debug-runtime JSON:', error.message);
  process.exit(1);
}

try {
  front = frontendRuntime ? JSON.parse(frontendRuntime) : null;
} catch (error) {
  console.error('[portolan] failed to parse frontend debug runtime JSON:', error.message);
  process.exit(1);
}

try {
  native = JSON.parse(nativeStatusRuntime);
} catch (error) {
  console.error('[portolan] failed to parse native_status JSON:', error.message);
  process.exit(1);
}

function readServerNativeBackend(data) {
  if (!data || typeof data !== 'object') return null;
  const runtime = data?.runtime;
  if (!runtime || typeof runtime !== 'object') return null;
  const nativeBackend = runtime?.nativeBackend;
  return nativeBackend && typeof nativeBackend === 'object' ? nativeBackend : null;
}

function compareNativeLifecycle(serverPayload, nativePayload) {
  const nativeBackend = readServerNativeBackend(serverPayload);
  const nativeBackendStatus = nativePayload?.backend ?? null;

  if (!nativeBackendStatus || typeof nativeBackendStatus !== 'object') {
    return {
      status: 'unavailable',
      backendOwner: null,
      serverNativeBackend: nativeBackend,
      mismatches: ['native_status export did not include backend status'],
    };
  }

  if (nativeBackendStatus.owner === 'external') {
    return {
      status: nativeBackend ? 'owner-mismatch' : 'matched',
      backendOwner: nativeBackendStatus.owner,
      serverNativeBackend: nativeBackend,
      mismatches: nativeBackend
        ? ['native_status reports an external backend, but /debug-runtime reports PORTOLAN_NATIVE=1']
        : [],
    };
  }

  if (!nativeBackend) {
    return {
      status: 'missing-server-native-backend',
      backendOwner: nativeBackendStatus.owner,
      serverNativeBackend: null,
      mismatches: [`native_status reports a ${nativeBackendStatus.owner} backend, but /debug-runtime has no nativeBackend block`],
    };
  }

  const expectedRuntime = {
    enabled: true,
    launchKind: 'node-dist-resource',
    supervised: true,
  };
  const mismatches = Object.entries(expectedRuntime)
    .map(([key, value]) =>
      nativeBackend?.[key] !== value
        ? `runtime.nativeBackend.${key} expected ${JSON.stringify(value)}; got ${JSON.stringify(nativeBackend?.[key])}`
        : null,
    )
    .filter(Boolean);
  if (nativeBackendStatus.owner !== 'app') {
    mismatches.push(`native_status.backend.owner expected "app"; got ${JSON.stringify(nativeBackendStatus.owner)}`);
  }
  if (nativeBackendStatus.reachable !== true) {
    mismatches.push(`native_status.backend.reachable expected true; got ${JSON.stringify(nativeBackendStatus.reachable)}`);
  }
  if (nativeBackendStatus.pid == null) {
    mismatches.push('native_status.backend.pid must be present for app-owned backend');
  }
  for (const mismatch of [
    nativeBackend.launchKind !== undefined && nativeBackend.launchKind !== nativeBackendStatus.launchKind
      ? `launchKind differs: native_status=${nativeBackendStatus.launchKind} debug-runtime=${String(nativeBackend.launchKind)}`
      : null,
    nativeBackend.backendRoot !== undefined && nativeBackend.backendRoot !== nativeBackendStatus.cwd
      ? `backendRoot differs: native_status.cwd=${nativeBackendStatus.cwd} debug-runtime=${String(nativeBackend.backendRoot)}`
      : null,
    nativeBackend.resourceDir !== undefined && nativeBackend.resourceDir !== nativeBackendStatus.resourceDir
      ? `resourceDir differs: native_status=${String(nativeBackendStatus.resourceDir)} debug-runtime=${String(nativeBackend.resourceDir)}`
      : null,
    nativeBackend.processGroup !== undefined && nativeBackend.processGroup !== nativeBackendStatus.processGroup
      ? `processGroup differs: native_status=${String(nativeBackendStatus.processGroup)} debug-runtime=${String(nativeBackend.processGroup)}`
      : null,
  ].filter(Boolean)) mismatches.push(mismatch);

  return {
    status: mismatches.length === 0 ? 'matched' : 'drift',
    backendOwner: nativeBackendStatus.owner,
    serverNativeBackend: nativeBackend,
    mismatches,
  };
}

function compareWorkspaceWindows(nativePayload) {
  const workspaceWindows = nativePayload?.workspaceWindows ?? null;
  if (!workspaceWindows || typeof workspaceWindows !== 'object') {
    return {
      status: 'unavailable',
      mismatches: ['native_status export did not include workspaceWindows status'],
    };
  }

  const exactTitleMatches = (title, expected) => title === expected;
  const parseRoute = (routeUrl) => {
    if (typeof routeUrl !== 'string' || !routeUrl.startsWith('#')) return null;
    const params = new URLSearchParams(routeUrl.slice(1));
    const city = params.get('city');
    return city ? { city, mode: params.get('mode') } : null;
  };
  const expectedRecentCount = 4;
  const expectedWorkspaceCount = 3;
  const mismatches = [];
  if (workspaceWindows.recentCount !== expectedRecentCount) {
    mismatches.push(`native_status.workspaceWindows.recentCount expected ${expectedRecentCount}; got ${JSON.stringify(workspaceWindows.recentCount)}`);
  }
  if (workspaceWindows.workspaceCount !== expectedWorkspaceCount) {
    mismatches.push(`native_status.workspaceWindows.workspaceCount expected ${expectedWorkspaceCount}; got ${JSON.stringify(workspaceWindows.workspaceCount)}`);
  }
  const mainRoute = parseRoute(workspaceWindows.mainRouteUrl);
  if (!mainRoute || mainRoute.mode !== null) {
    mismatches.push(`native_status.workspaceWindows.mainRouteUrl expected a local map route; got ${JSON.stringify(workspaceWindows.mainRouteUrl)}`);
  }

  const routes = Array.isArray(workspaceWindows.routes) ? workspaceWindows.routes : null;
  if (!routes) {
    mismatches.push('native_status.workspaceWindows.routes must be an array');
  } else {
    if (routes.length !== expectedRecentCount) {
      mismatches.push(`native_status.workspaceWindows.routes length expected ${expectedRecentCount}; got ${routes.length}`);
    }
    const byLabel = new Map();
    for (const entry of routes) {
      if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string') {
        mismatches.push('native_status.workspaceWindows.routes contains a malformed entry');
        continue;
      }
      if (byLabel.has(entry.label)) {
        mismatches.push(`native_status.workspaceWindows.routes duplicated label ${JSON.stringify(entry.label)}`);
        continue;
      }
      byLabel.set(entry.label, entry);
    }

    const mainEntry = byLabel.get(process.env.RESTORE_MAIN_LABEL);
    if (!mainEntry) {
      mismatches.push(`native_status.workspaceWindows.routes missing ${JSON.stringify(process.env.RESTORE_MAIN_LABEL)}`);
    } else {
      const route = parseRoute(mainEntry.routeUrl);
      if (!route || route.mode !== null) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_MAIN_LABEL)}].routeUrl expected a local map route; got ${JSON.stringify(mainEntry.routeUrl)}`);
      } else if (mainRoute && route.city !== mainRoute.city) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_MAIN_LABEL)}].city expected ${JSON.stringify(mainRoute.city)}; got ${JSON.stringify(route.city)}`);
      }
      if (mainEntry.title !== process.env.RESTORE_MAIN_MAP_TITLE) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_MAIN_LABEL)}].title expected ${JSON.stringify(process.env.RESTORE_MAIN_MAP_TITLE)}; got ${JSON.stringify(mainEntry.title)}`);
      }
      if (mainEntry.isMain !== true) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_MAIN_LABEL)}].isMain expected true; got ${JSON.stringify(mainEntry.isMain)}`);
      }
      if (typeof mainEntry.updatedAtUnix !== 'number' || !Number.isFinite(mainEntry.updatedAtUnix)) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_MAIN_LABEL)}].updatedAtUnix must be a finite number`);
      } else if (mainEntry.updatedAtUnix <= Number(process.env.RESTORE_MAIN_SEEDED_UPDATED_AT || '0')) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_MAIN_LABEL)}].updatedAtUnix expected > ${JSON.stringify(process.env.RESTORE_MAIN_SEEDED_UPDATED_AT)}; got ${JSON.stringify(mainEntry.updatedAtUnix)}`);
      }
    }

    const workspaceEntry = byLabel.get(process.env.RESTORE_WORKSPACE_LABEL);
    let findCity = null;
    if (!workspaceEntry) {
      mismatches.push(`native_status.workspaceWindows.routes missing ${JSON.stringify(process.env.RESTORE_WORKSPACE_LABEL)}`);
    } else {
      const route = parseRoute(workspaceEntry.routeUrl);
      if (!route || route.mode !== 'find') {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_WORKSPACE_LABEL)}].routeUrl expected a local find route; got ${JSON.stringify(workspaceEntry.routeUrl)}`);
      } else {
        findCity = route.city;
      }
      if (!exactTitleMatches(workspaceEntry.title, process.env.RESTORE_WORKSPACE_TITLE)) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_WORKSPACE_LABEL)}].title expected ${JSON.stringify(process.env.RESTORE_WORKSPACE_TITLE)}; got ${JSON.stringify(workspaceEntry.title)}`);
      }
      if (workspaceEntry.isMain !== false) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_WORKSPACE_LABEL)}].isMain expected false; got ${JSON.stringify(workspaceEntry.isMain)}`);
      }
      if (typeof workspaceEntry.updatedAtUnix !== 'number' || !Number.isFinite(workspaceEntry.updatedAtUnix)) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_WORKSPACE_LABEL)}].updatedAtUnix must be a finite number`);
      } else if (workspaceEntry.updatedAtUnix <= Number(process.env.RESTORE_WORKSPACE_SEEDED_UPDATED_AT || '0')) {
        mismatches.push(`native_status.workspaceWindows.routes[${JSON.stringify(process.env.RESTORE_WORKSPACE_LABEL)}].updatedAtUnix expected > ${JSON.stringify(process.env.RESTORE_WORKSPACE_SEEDED_UPDATED_AT)}; got ${JSON.stringify(workspaceEntry.updatedAtUnix)}`);
      }
    }

    const duplicates = routes.filter(entry => entry && typeof entry === 'object' && typeof entry.label === 'string' && ![process.env.RESTORE_MAIN_LABEL, process.env.RESTORE_WORKSPACE_LABEL].includes(entry.label));
    if (duplicates.length !== 2) {
      mismatches.push(`native_status.workspaceWindows.routes expected 2 duplicated workspace entries; got ${duplicates.length}`);
    } else {
      const mapDuplicates = duplicates.filter(entry => {
        const route = parseRoute(entry.routeUrl);
        return route && route.mode === null && (!mainRoute || route.city === mainRoute.city);
      });
      const findDuplicates = duplicates.filter(entry => {
        const route = parseRoute(entry.routeUrl);
        return route && route.mode === 'find' && (!findCity || route.city === findCity);
      });
      if (mapDuplicates.length !== 1) {
        mismatches.push(`native_status.workspaceWindows.routes expected 1 duplicated map entry; got ${mapDuplicates.length}`);
      } else {
        const duplicate = mapDuplicates[0];
        if (duplicate.title !== process.env.RESTORE_MAIN_MAP_TITLE) {
          mismatches.push(`native_status.workspaceWindows.duplicateMap.title expected ${JSON.stringify(process.env.RESTORE_MAIN_MAP_TITLE)}; got ${JSON.stringify(duplicate.title)}`);
        }
        if (duplicate.isMain !== false) {
          mismatches.push(`native_status.workspaceWindows.duplicateMap.isMain expected false; got ${JSON.stringify(duplicate.isMain)}`);
        }
        if (typeof duplicate.updatedAtUnix !== 'number' || !Number.isFinite(duplicate.updatedAtUnix)) {
          mismatches.push('native_status.workspaceWindows.duplicateMap.updatedAtUnix must be a finite number');
        } else if (duplicate.updatedAtUnix <= Number(process.env.RESTORE_MAIN_SEEDED_UPDATED_AT || '0')) {
          mismatches.push(`native_status.workspaceWindows.duplicateMap.updatedAtUnix expected > ${JSON.stringify(process.env.RESTORE_MAIN_SEEDED_UPDATED_AT)}; got ${JSON.stringify(duplicate.updatedAtUnix)}`);
        }
      }
      if (findDuplicates.length !== 1) {
        mismatches.push(`native_status.workspaceWindows.routes expected 1 duplicated find entry; got ${findDuplicates.length}`);
      } else {
        const duplicate = findDuplicates[0];
        if (!exactTitleMatches(duplicate.title, process.env.RESTORE_WORKSPACE_TITLE)) {
          mismatches.push(`native_status.workspaceWindows.duplicateFind.title expected ${JSON.stringify(process.env.RESTORE_WORKSPACE_TITLE)}; got ${JSON.stringify(duplicate.title)}`);
        }
        if (duplicate.isMain !== false) {
          mismatches.push(`native_status.workspaceWindows.duplicateFind.isMain expected false; got ${JSON.stringify(duplicate.isMain)}`);
        }
        if (typeof duplicate.updatedAtUnix !== 'number' || !Number.isFinite(duplicate.updatedAtUnix)) {
          mismatches.push('native_status.workspaceWindows.duplicateFind.updatedAtUnix must be a finite number');
        } else if (duplicate.updatedAtUnix <= Number(process.env.RESTORE_WORKSPACE_SEEDED_UPDATED_AT || '0')) {
          mismatches.push(`native_status.workspaceWindows.duplicateFind.updatedAtUnix expected > ${JSON.stringify(process.env.RESTORE_WORKSPACE_SEEDED_UPDATED_AT)}; got ${JSON.stringify(duplicate.updatedAtUnix)}`);
        }
      }
    }
  }

  return {
    status: mismatches.length === 0 ? 'matched' : 'drift',
    mismatches,
  };
}

const nativeLifecycle = front?.nativeLifecycle ?? compareNativeLifecycle(payload, native);
const workspaceWindows = compareWorkspaceWindows(native);
if (workspaceWindows.status !== 'matched') {
  const mismatches = Array.isArray(workspaceWindows.mismatches)
    ? workspaceWindows.mismatches.join('; ')
    : String(workspaceWindows.mismatches || '');
  const detail = mismatches || '<none>';
  console.error(`[portolan] native_status workspace duplication shape mismatch: status=${workspaceWindows.status} mismatches=${detail}`);
  process.exit(1);
}
console.log('[portolan] native_status workspace duplication shape validated');

if (strictOwned) {
  if (nativeLifecycle.status !== 'matched' || nativeLifecycle.backendOwner !== 'app') {
    const mismatches = Array.isArray(nativeLifecycle.mismatches)
      ? nativeLifecycle.mismatches.join('; ')
      : String(nativeLifecycle.mismatches || '');
    const detail = mismatches || '<none>';
    console.error(
      `[portolan] strict app-owned validation failed: status=${nativeLifecycle.status} owner=${nativeLifecycle.backendOwner} mismatches=${detail}`,
    );
    process.exit(1);
  }
  console.log('[portolan] native lifecycle validated as app-owned matched');
  console.log('[portolan] nativeLifecycle', JSON.stringify(nativeLifecycle, null, 2));
} else if (allowExternal) {
  if (nativeLifecycle.status === 'unavailable') {
    console.log('[portolan] native status unavailable; skipping lifecycle ownership assertion for external mode');
  } else if (nativeLifecycle.status !== 'matched' || nativeLifecycle.backendOwner !== 'external') {
    const mismatches = Array.isArray(nativeLifecycle.mismatches)
      ? nativeLifecycle.mismatches.join('; ')
      : String(nativeLifecycle.mismatches || '');
    const detail = mismatches || '<none>';
    console.error(
      `[portolan] external mode expects nativeLifecycle.status=matched owner=external; got status=${nativeLifecycle.status} owner=${nativeLifecycle.backendOwner} mismatches=${detail}`,
    );
    process.exit(1);
  } else {
    console.log('[portolan] native lifecycle validated as external matched');
  }
}
NODE

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
