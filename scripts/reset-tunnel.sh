#!/bin/bash
# Reset the launchd-managed SSH tunnel and restart a remote Portolan agent runtime.
#
# Usage: ./scripts/reset-tunnel.sh [--manual] [--no-agent-restart] [--agent-runtime node|rust] <ssh-host>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./remote-agent-runtime.sh
source "$SCRIPT_DIR/remote-agent-runtime.sh"

MANUAL=false
RESTART_AGENT=true
AGENT_RUNTIME="rust"
AGENT_SESSION=""
AGENT_ORIGIN=""
AGENT_PLANNOTATOR_PORT=""
AGENT_ONCE=false
HOST=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/reset-tunnel.sh [options] <ssh-host>

Options:
  --manual             Bypass launchd and run the old one-shot ssh recovery path
  --agent-runtime      Select runtime to restart: node|rust (default: rust)
  --agent-session      Override tmux session name for restart target
  --origin             Origin identifier for rust agent runtime (if different from hostname)
  --plannotator-port   Optional plannotator socket port (rust agent only)
  --once               Run rust agent once (exits after disconnect)
  --no-agent-restart   Only reset the tunnel; do not restart the remote agent session
  -h, --help           Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --manual)
      MANUAL=true
      shift
      ;;
    --agent-runtime)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --agent-runtime" >&2
        usage >&2
        exit 1
      fi
      AGENT_RUNTIME="$2"
      shift 2
      ;;
    --agent-runtime=*)
      AGENT_RUNTIME="${1#*=}"
      shift
      ;;
    --origin)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --origin" >&2
        usage >&2
        exit 1
      fi
      AGENT_ORIGIN="$2"
      shift 2
      ;;
    --origin=*)
      AGENT_ORIGIN="${1#*=}"
      shift
      ;;
    --plannotator-port)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --plannotator-port" >&2
        usage >&2
        exit 1
      fi
      AGENT_PLANNOTATOR_PORT="$2"
      shift 2
      ;;
    --plannotator-port=*)
      AGENT_PLANNOTATOR_PORT="${1#*=}"
      shift
      ;;
    --once)
      AGENT_ONCE=true
      shift
      ;;
    --no-agent-restart)
      RESTART_AGENT=false
      shift
      ;;
    --agent-session)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --agent-session" >&2
        usage >&2
        exit 1
      fi
      AGENT_SESSION="$2"
      shift 2
      ;;
    --agent-session=*)
      AGENT_SESSION="${1#*=}"
      shift
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
      if [ -n "$HOST" ]; then
        echo "Unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      HOST="$1"
      shift
      ;;
  esac
done

if [ -z "$HOST" ]; then
  usage >&2
  exit 1
fi

if [ "$AGENT_RUNTIME" != "node" ] && [ "$AGENT_RUNTIME" != "rust" ]; then
  echo "Invalid --agent-runtime value: $AGENT_RUNTIME (must be node or rust)" >&2
  usage >&2
  exit 1
fi

if [ -n "$AGENT_PLANNOTATOR_PORT" ] && ! echo "$AGENT_PLANNOTATOR_PORT" | grep -Eq '^[0-9]+$'; then
  echo "--plannotator-port must be numeric" >&2
  usage >&2
  exit 1
fi

if [ -n "$AGENT_PLANNOTATOR_PORT" ] && { [ "$AGENT_PLANNOTATOR_PORT" -lt 1 ] || [ "$AGENT_PLANNOTATOR_PORT" -gt 65535 ]; }; then
  echo "--plannotator-port must be in range 1-65535" >&2
  usage >&2
  exit 1
fi

if [ "$AGENT_RUNTIME" != "rust" ]; then
  if [ -n "$AGENT_ORIGIN" ]; then
    echo "Ignoring --origin for node runtime (unsupported)" >&2
  fi
  if [ -n "$AGENT_PLANNOTATOR_PORT" ]; then
    echo "Ignoring --plannotator-port for node runtime (unsupported)" >&2
  fi
  if [ "$AGENT_ONCE" = true ]; then
    echo "Ignoring --once for node runtime (unsupported)" >&2
  fi
fi

shell_quote_word() {
  printf "%q" "$1"
}

require_ssh_connection() {
  local host="$1"
  local output

  if output="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" "echo ok" 2>&1)"; then
    return 0
  fi

  echo "[$host] ERROR: SSH preflight failed before touching tunnels or agent sessions" >&2
  if echo "$output" | grep -Fq "no such identity:"; then
    echo "[$host] Missing SSH identity file in local ssh config:" >&2
    echo "$output" | grep -F "no such identity:" >&2
  fi
  echo "$output" >&2
  return 1
}

wait_for_agent_connect() {
  local host="$1"
  local session="$2"
  local runtime="$3"
  local command="$4"
  local attempt
  local session_log=""
  local connected=false
  local marker_pattern="[portolan-agent-rust] READY runtime=rust"
  local legacy_pattern="Connected|registered as|agentRuntime=${runtime}"

  echo "[$host] Runtime command: $command"
  echo "[$host] Verifying session '$session'..."
  for attempt in $(seq 1 10); do
    session_log="$(ssh "$host" "tmux capture-pane -t $(shell_quote_word "$session") -p" 2>/dev/null || true)"
    if [ "$runtime" = "rust" ] && echo "$session_log" | grep -Fq "$marker_pattern"; then
      connected=true
      break
    fi
    if [ "$runtime" = "rust" ] && echo "$session_log" | grep -Eq "$legacy_pattern"; then
      connected=true
      break
    fi
    if [ "$runtime" != "rust" ] && echo "$session_log" | grep -Eq "$legacy_pattern"; then
      connected=true
      break
    fi
    sleep 1
  done

  if [ -n "$session_log" ]; then
    echo "[$host] Session tail:"
    echo "$session_log" | tail -n 12
  else
    echo "[$host] Session tail unavailable yet"
  fi

  if [ "$connected" = true ]; then
    echo "[$host] Agent connected"
    return 0
  fi

  echo "[$host] WARNING: agent may not have connected yet; check: ssh $host 'tmux attach -t $session'"
  return 1
}

build_agent_cmd() {
  local runtime="$1"
  local host="$2"
  local origin="$3"
  local plannotator_port="$4"
  local once="$5"

  if [ "$runtime" = "rust" ]; then
    local cmd="~/.local/bin/portolan-agent-rust connect --ssh-host=$(shell_quote_word "$host")"
    if [ -n "$origin" ]; then
      cmd="$cmd --origin=$(shell_quote_word "$origin")"
    fi
    if [ -n "$plannotator_port" ]; then
      cmd="$cmd --plannotator-port=$(shell_quote_word "$plannotator_port")"
    fi
    if [ "$once" = true ]; then
      cmd="$cmd --once"
    fi
    echo "$cmd"
  else
    echo "node ~/.local/bin/portolan-agent.js connect --ssh-host=$(shell_quote_word "$host")"
  fi
}

preflight_agent_runtime() {
  local runtime="$1"
  local host="$2"

  if [ "$runtime" = "rust" ]; then
    echo "[$host] Preflighting Rust agent binary..."
    ssh "$host" "test -x ~/.local/bin/portolan-agent-rust" || {
      echo "[$host] ERROR: Rust agent is not installed or executable at ~/.local/bin/portolan-agent-rust" >&2
      echo "[$host] Install first: ./scripts/install-remote.sh $host" >&2
      return 1
    }
    return 0
  fi

  echo "[$host] Preflighting explicit Node fallback..."
  ssh "$host" "test -f ~/.local/bin/portolan-agent.js && command -v node >/dev/null 2>&1" || {
    echo "[$host] ERROR: Node fallback is not installed or node is unavailable" >&2
    echo "[$host] Install first: ./scripts/install-remote.sh --agent-runtime node $host" >&2
    return 1
  }
}

if [ -z "$AGENT_SESSION" ]; then
  AGENT_SESSION="$(remote_agent_tmux_session "$AGENT_RUNTIME")"
fi

AGENT_CMD="$(build_agent_cmd "$AGENT_RUNTIME" "$HOST" "$AGENT_ORIGIN" "$AGENT_PLANNOTATOR_PORT" "$AGENT_ONCE")"
REPLACES_RUNTIME=true
if [ "$AGENT_RUNTIME" = "rust" ] && [ "$AGENT_ONCE" = true ]; then
  REPLACES_RUNTIME=false
fi
OPPOSITE_AGENT_SESSIONS="$(replaced_remote_agent_tmux_sessions "$AGENT_RUNTIME")"
OPPOSITE_AGENT_SESSION="$(printf '%s\n' "$OPPOSITE_AGENT_SESSIONS" | head -n 1)"
OPPOSITE_AGENT_SESSIONS_STR="$(printf '%s\n' "$OPPOSITE_AGENT_SESSIONS" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

LABEL="com.cailmdaley.portolan-tunnel-$HOST"
TARGET="gui/$(id -u)/$LABEL"

require_ssh_connection "$HOST"

manual_reconnect() {
  echo "[$HOST] Killing ControlMaster..."
  ssh -O exit "$HOST" 2>/dev/null || true

  SOCKET=$(ssh -G "$HOST" 2>/dev/null | awk '/^controlpath / {print $2}')
  if [ -n "$SOCKET" ] && [ -S "$SOCKET" ]; then
    rm -f "$SOCKET"
    echo "[$HOST] Removed stale socket: $SOCKET"
  fi

  echo "[$HOST] Clearing stale forwarding sessions..."
  ssh "$HOST" 'pkill -u $(whoami) -f "sshd:.*@notty" 2>/dev/null; true'
  sleep 1

  echo "[$HOST] Re-establishing one-shot tunnel..."
  ssh -f \
    -S none \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ControlMaster=no \
    -o ExitOnForwardFailure=yes \
    -R 4004:localhost:4004 \
    "$HOST" \
    'sleep 3600'
}

if [ "$MANUAL" = true ]; then
  manual_reconnect
else
  echo "[$HOST] Kickstarting launchd tunnel: $TARGET"
  if ! launchctl kickstart -k "$TARGET"; then
    echo "[$HOST] ERROR: launchctl kickstart failed"
    echo "[$HOST] Install first: ./scripts/install-tunnels.sh $HOST"
    echo "[$HOST] Emergency fallback: ./scripts/reset-tunnel.sh --manual $HOST"
    exit 1
  fi
fi

sleep 1

TUNNEL_OK=false
for _ in $(seq 1 20); do
  if ssh "$HOST" 'curl -s --connect-timeout 3 http://localhost:4004/' >/dev/null 2>&1; then
    TUNNEL_OK=true
    break
  fi
  sleep 1
done

if [ "$TUNNEL_OK" != true ]; then
  echo "[$HOST] ERROR: tunnel still broken; remote localhost:4004 not reachable"
  echo "[$HOST] Check launchd: launchctl print $TARGET"
  echo "[$HOST] Port held remotely? ssh $HOST 'fuser -k 4004/tcp'"
  exit 1
fi
echo "[$HOST] Tunnel OK"

if [ "$RESTART_AGENT" != true ]; then
  exit 0
fi

preflight_agent_runtime "$AGENT_RUNTIME" "$HOST"

echo "[$HOST] Restarting remote runtime '$AGENT_RUNTIME' in tmux session '$AGENT_SESSION'..."
ssh "$HOST" "tmux kill-session -t '$AGENT_SESSION' 2>/dev/null; true"
if [ "$REPLACES_RUNTIME" = true ]; then
  echo "[$HOST] Stopping opposite runtime session(s) '$OPPOSITE_AGENT_SESSIONS_STR' to keep one live origin socket..."
  for opposite_session in $OPPOSITE_AGENT_SESSIONS; do
    ssh "$HOST" "tmux kill-session -t '$opposite_session' 2>/dev/null; true"
  done
else
  echo "[$HOST] Leaving opposite runtime session '$OPPOSITE_AGENT_SESSION' untouched for one-shot Rust agent"
fi
ssh "$HOST" "tmux new-session -d -s '$AGENT_SESSION' 'bash -l -c \"${AGENT_CMD}\"'"

wait_for_agent_connect "$HOST" "$AGENT_SESSION" "$AGENT_RUNTIME" "$AGENT_CMD" || true
