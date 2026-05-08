#!/bin/bash
# Install launchd-managed autossh tunnels for remote portolan-agent hosts.
#
# Usage:
#   ./scripts/install-tunnels.sh [candide|cineca ...]
#   ./scripts/install-tunnels.sh --write-only --plist-dir /tmp/LaunchAgents candide

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.local/state/portolan"
AUTOSSH_PATH=""
WRITE_ONLY=false
HOSTS=()

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-tunnels.sh [options] [candide|cineca ...]

Options:
  --write-only          Write plists without bootstrapping launchd
  --plist-dir DIR       Directory for launchd plists (default: ~/Library/LaunchAgents)
  --log-dir DIR         Directory for autossh logs (default: ~/.local/state/portolan)
  --autossh-path PATH   autossh binary path (default: resolve from PATH)
  -h, --help            Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --write-only)
      WRITE_ONLY=true
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
    --autossh-path)
      AUTOSSH_PATH="${2:?--autossh-path requires a path}"
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
      HOSTS+=("$1")
      shift
      ;;
  esac
done

if [ "${#HOSTS[@]}" -eq 0 ]; then
  HOSTS=(candide cineca)
fi

if [ -z "$AUTOSSH_PATH" ]; then
  if ! AUTOSSH_PATH="$(command -v autossh)"; then
    echo "autossh not found on PATH; install with 'brew install autossh' or pass --autossh-path" >&2
    exit 1
  fi
fi

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

render_plist() {
  local host="$1"
  local label="$2"
  local log_path="$3"
  local escaped_host escaped_label escaped_autossh escaped_log escaped_home

  escaped_host="$(xml_escape "$host")"
  escaped_label="$(xml_escape "$label")"
  escaped_autossh="$(xml_escape "$AUTOSSH_PATH")"
  escaped_log="$(xml_escape "$log_path")"
  escaped_home="$(xml_escape "$HOME")"

  cat <<PLIST_HEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$escaped_label</string>

  <key>ProgramArguments</key>
  <array>
    <string>$escaped_autossh</string>
    <string>-M</string>
    <string>0</string>
    <string>-S</string>
    <string>none</string>
    <string>-o</string>
    <string>ServerAliveInterval=30</string>
    <string>-o</string>
    <string>ServerAliveCountMax=3</string>
    <string>-o</string>
    <string>ControlMaster=no</string>
    <string>-o</string>
    <string>ExitOnForwardFailure=yes</string>
PLIST_HEAD

  if [ -n "${SSH_AUTH_SOCK:-}" ]; then
    local escaped_sock
    escaped_sock="$(xml_escape "$SSH_AUTH_SOCK")"
    cat <<PLIST_SOCK_ARGS
    <string>-o</string>
    <string>IdentityAgent=$escaped_sock</string>
PLIST_SOCK_ARGS
  fi

  cat <<PLIST_MID
    <string>-R</string>
    <string>4004:localhost:4004</string>
    <string>$escaped_host</string>
    <string>sleep 2147483647</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>AUTOSSH_GATETIME</key>
    <string>0</string>
PLIST_MID

  if [ -n "${SSH_AUTH_SOCK:-}" ]; then
    local escaped_sock
    escaped_sock="$(xml_escape "$SSH_AUTH_SOCK")"
    cat <<PLIST_SOCK_ENV
    <key>SSH_AUTH_SOCK</key>
    <string>$escaped_sock</string>
PLIST_SOCK_ENV
  fi

  cat <<PLIST_TAIL
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>NetworkState</key>
    <true/>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>$escaped_log</string>
  <key>StandardErrorPath</key>
  <string>$escaped_log</string>
  <key>WorkingDirectory</key>
  <string>$escaped_home</string>
</dict>
</plist>
PLIST_TAIL
}

install_host() {
  local host="$1"
  case "$host" in
    candide|cineca) ;;
    *)
      echo "Unknown tunnel host '$host' (supported: candide, cineca)" >&2
      exit 1
      ;;
  esac

  local label="com.cailmdaley.portolan-tunnel-$host"
  local plist_path="$PLIST_DIR/$label.plist"
  local log_path="$LOG_DIR/tunnel-$host.log"
  local target="gui/$(id -u)/$label"

  mkdir -p "$PLIST_DIR" "$LOG_DIR"
  render_plist "$host" "$label" "$log_path" > "$plist_path"

  echo "installed $label -> $plist_path"
  echo "  log: $log_path"

  if [ "$WRITE_ONLY" = true ]; then
    return
  fi

  launchctl bootout "$target" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl kickstart -k "$target"
  echo "  bootstrapped $target"
}

for host in "${HOSTS[@]}"; do
  install_host "$host"
done
