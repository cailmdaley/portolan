#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="${PORTOLAN_APP_PATH:-$REPO_DIR/src-tauri/target/release/bundle/macos/Portolan.app}"
APP_ID="${PORTOLAN_APP_ID:-com.cailmdaley.portolan}"
APP_DATA_DIR="${PORTOLAN_APP_DATA_DIR:-$HOME/Library/Application Support/$APP_ID}"
APP_NAME="${PORTOLAN_APP_NAME:-}"
WINDOW_STORE="$APP_DATA_DIR/workspace-windows.json"
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

require_command open
require_command osascript
require_command curl
require_command node
require_command /usr/libexec/PlistBuddy

stop_dev_stack_for_strict_smoke

if [[ ! -d "$APP_PATH" ]]; then
  echo "[portolan] built app bundle not found: $APP_PATH" >&2
  echo "[portolan] run npm run tauri:build first, or pass --app /path/to/Portolan.app" >&2
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
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/portolan-native-gui-smoke.XXXXXX")"
NATIVE_STATUS_PATH="$SMOKE_DIR/native-status.json"
PORTOLAN_NATIVE_STATUS_PATH="$NATIVE_STATUS_PATH" "$APP_EXECUTABLE" >/dev/null 2>&1 &
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

collect_frontend_debug_runtime || true
NATIVE_STATUS_JSON="$(wait_for_native_status)"

DEBUG_RUNTIME="$debug_runtime" WINDOW_DEBUG_RUNTIME_JSON="$WINDOW_DEBUG_RUNTIME_JSON" NATIVE_STATUS_JSON="$NATIVE_STATUS_JSON" \
  STRICT_APP_OWNED="$STRICT_APP_OWNED" ALLOW_EXTERNAL_BACKEND="$ALLOW_EXTERNAL_BACKEND" \
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

const nativeLifecycle = front?.nativeLifecycle ?? compareNativeLifecycle(payload, native);

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
