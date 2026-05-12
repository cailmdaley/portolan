#!/bin/bash
# Install the launchd-managed Apple Reminders mirror for felt fibers.
#
# Usage:
#   ./scripts/install-reminders-bridge.sh
#   ./scripts/install-reminders-bridge.sh --write-only --plist-dir /tmp/LaunchAgents
#   ./scripts/install-reminders-bridge.sh --uninstall

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL_DIR="$REPO_DIR/tools/reminders-bridge"
LABEL="com.cailmdaley.portolan-reminders-bridge"
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.local/state/portolan"
VENV_DIR="$HOME/.local/share/portolan/reminders-bridge-venv"
FELT_STORE="$HOME/loom"
CALENDAR="Fibers"
PYTHON_BIN=""
WRITE_ONLY=false
SKIP_DEPS=false
UNINSTALL=false
KICKSTART=true

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-reminders-bridge.sh [options]

Options:
  --write-only        Render the plist without bootstrapping launchd
  --skip-deps         Do not create/update the venv
  --uninstall         Unload and remove the launchd plist
  --no-kickstart      Bootstrap without an immediate first run
  --plist-dir DIR     LaunchAgents directory (default: ~/Library/LaunchAgents)
  --log-dir DIR       Log directory (default: ~/.local/state/portolan)
  --venv-dir DIR      Virtualenv directory (default: ~/.local/share/portolan/reminders-bridge-venv)
  --felt-store DIR    felt store root (default: ~/loom)
  --calendar NAME     Reminders list/calendar name (default: Fibers)
  --python PATH       Python used to create the venv
  -h, --help          Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --write-only)
      WRITE_ONLY=true
      shift
      ;;
    --skip-deps)
      SKIP_DEPS=true
      shift
      ;;
    --uninstall)
      UNINSTALL=true
      shift
      ;;
    --no-kickstart)
      KICKSTART=false
      shift
      ;;
    --plist-dir)
      PLIST_DIR="${2:?--plist-dir requires a directory}"
      shift 2
      ;;
    --log-dir)
      LOG_DIR="${2:?--log-dir requires a directory}"
      shift 2
      ;;
    --venv-dir)
      VENV_DIR="${2:?--venv-dir requires a directory}"
      shift 2
      ;;
    --felt-store)
      FELT_STORE="${2:?--felt-store requires a directory}"
      shift 2
      ;;
    --calendar)
      CALENDAR="${2:?--calendar requires a name}"
      shift 2
      ;;
    --python)
      PYTHON_BIN="${2:?--python requires a path}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      echo "Unexpected argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

resolve_python() {
  if [ -n "$PYTHON_BIN" ]; then
    printf '%s\n' "$PYTHON_BIN"
    return
  fi
  for candidate in python3.13 python3.12 python3.11 python3; do
    if path="$(command -v "$candidate" 2>/dev/null)"; then
      printf '%s\n' "$path"
      return
    fi
  done
  echo "python3 not found on PATH" >&2
  exit 1
}

plist_path="$PLIST_DIR/$LABEL.plist"
target="gui/$(id -u)/$LABEL"

if [ "$UNINSTALL" = true ]; then
  launchctl bootout "$target" >/dev/null 2>&1 || true
  rm -f "$plist_path"
  echo "uninstalled $LABEL"
  exit 0
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR" "$(dirname "$VENV_DIR")"
PYTHON_BIN="$(resolve_python)"

if [ "$SKIP_DEPS" != true ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install -e "$TOOL_DIR"
  RUN_PYTHON="$VENV_DIR/bin/python"
else
  RUN_PYTHON="$PYTHON_BIN"
fi

log_path="$LOG_DIR/reminders-bridge.log"
pythonpath="$TOOL_DIR/src"

sed \
  -e "s#__LABEL__#$(xml_escape "$LABEL")#g" \
  -e "s#__PYTHON__#$(xml_escape "$RUN_PYTHON")#g" \
  -e "s#__FELT_STORE__#$(xml_escape "$FELT_STORE")#g" \
  -e "s#__CALENDAR__#$(xml_escape "$CALENDAR")#g" \
  -e "s#__PYTHONPATH__#$(xml_escape "$pythonpath")#g" \
  -e "s#__REPO_DIR__#$(xml_escape "$REPO_DIR")#g" \
  -e "s#__LOG_PATH__#$(xml_escape "$log_path")#g" \
  "$SCRIPT_DIR/reminders-bridge.plist.tmpl" > "$plist_path"

echo "installed $LABEL -> $plist_path"
echo "  log: $log_path"
echo "  python: $RUN_PYTHON"

if [ "$WRITE_ONLY" = true ]; then
  exit 0
fi

launchctl bootout "$target" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist_path"
if [ "$KICKSTART" = true ]; then
  launchctl kickstart -k "$target"
fi
echo "  bootstrapped $target"
