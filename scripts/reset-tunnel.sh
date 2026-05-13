#!/bin/bash
# Reset the launchd-managed SSH tunnel and restart a remote Portolan agent runtime.
#
# Usage: ./scripts/reset-tunnel.sh [--manual] [--no-agent-restart] [--agent-runtime node|rust] <ssh-host>

set -euo pipefail

MANUAL=false
RESTART_AGENT=true
AGENT_RUNTIME="node"
AGENT_SESSION=""
HOST=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/reset-tunnel.sh [options] <ssh-host>

Options:
  --manual             Bypass launchd and run the old one-shot ssh recovery path
  --agent-runtime      Select runtime to restart: node|rust (default: node)
  --agent-session      Override tmux session name for restart target
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

if [ -z "$AGENT_SESSION" ]; then
  if [ "$AGENT_RUNTIME" = "rust" ]; then
    AGENT_SESSION="portolan-agent-rust-preview"
  else
    AGENT_SESSION="portolan-agent"
  fi
fi

if [ "$AGENT_RUNTIME" = "rust" ]; then
  AGENT_CMD="~/.local/bin/portolan-agent-rust connect --ssh-host=$HOST"
else
  AGENT_CMD="node ~/.local/bin/portolan-agent.js connect --ssh-host=$HOST"
fi

LABEL="com.cailmdaley.portolan-tunnel-$HOST"
TARGET="gui/$(id -u)/$LABEL"

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

echo "[$HOST] Restarting remote runtime '$AGENT_RUNTIME' in tmux session '$AGENT_SESSION'..."
ssh "$HOST" "tmux kill-session -t '$AGENT_SESSION' 2>/dev/null; true"
ssh "$HOST" "tmux new-session -d -s '$AGENT_SESSION' 'bash -l -c \"${AGENT_CMD}\"'"
sleep 2

if ssh "$HOST" "tmux capture-pane -t '$AGENT_SESSION' -p" 2>/dev/null | grep -Eq "Connected|registered as"; then
  echo "[$HOST] Agent connected"
else
  echo "[$HOST] WARNING: agent may not have connected; check: ssh $HOST 'tmux attach -t $AGENT_SESSION'"
fi
