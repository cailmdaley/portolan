#!/bin/bash
# Reset the launchd-managed SSH tunnel and restart portolan-agent on a remote host.
#
# Usage: ./scripts/reset-tunnel.sh [--manual] [--no-agent-restart] <ssh-host>

set -euo pipefail

MANUAL=false
RESTART_AGENT=true
HOST=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/reset-tunnel.sh [options] <ssh-host>

Options:
  --manual             Bypass launchd and run the old one-shot ssh recovery path
  --no-agent-restart   Only reset the tunnel; do not restart portolan-agent
  -h, --help           Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --manual)
      MANUAL=true
      shift
      ;;
    --no-agent-restart)
      RESTART_AGENT=false
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

echo "[$HOST] Restarting portolan-agent..."
ssh "$HOST" "tmux kill-session -t portolan-agent 2>/dev/null; true"
ssh "$HOST" "tmux new-session -d -s portolan-agent 'bash -l -c \"node ~/.local/bin/portolan-agent.js connect --ssh-host=$HOST\"'"
sleep 2

if ssh "$HOST" "tmux capture-pane -t portolan-agent -p" 2>/dev/null | grep -q "Connected"; then
  echo "[$HOST] Agent connected"
else
  echo "[$HOST] WARNING: agent may not have connected; check: ssh $HOST 'tmux attach -t portolan-agent'"
fi
