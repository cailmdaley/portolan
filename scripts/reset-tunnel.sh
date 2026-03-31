#!/bin/bash
# Reset SSH tunnel and restart portolan-agent on a remote host.
#
# Usage: ./scripts/reset-tunnel.sh <ssh-host>
#
# Fixes the common failure mode where a stale ControlMaster leaves the
# RemoteForward 4004 tunnel dead, stranding the agent on a hung WebSocket.

set -e

HOST="${1:?Usage: $0 <ssh-host>}"

echo "[$HOST] Killing ControlMaster..."
ssh -O exit "$HOST" 2>/dev/null || true
# Remove stale socket file — ssh -O exit kills the process but the socket
# can linger, causing "ControlSocket already exists, disabling multiplexing"
# which prevents ssh -N -f from backgrounding properly.
SOCKET=$(ssh -G "$HOST" 2>/dev/null | awk '/^controlpath / {print $2}')
if [ -n "$SOCKET" ] && [ -S "$SOCKET" ]; then
    rm -f "$SOCKET"
    echo "[$HOST] Removed stale socket: $SOCKET"
fi

# Kill stale sshd forwarding sessions on the remote that may hold port 4004.
# These are user-owned "sshd: user@notty" processes left over from dead tunnels.
# The root priv-sep parent owns the LISTEN socket, but dies when the user child exits.
echo "[$HOST] Clearing stale forwarding sessions..."
ssh "$HOST" 'pkill -u $(whoami) -f "sshd:.*@notty" 2>/dev/null; true'
sleep 1

echo "[$HOST] Re-establishing tunnel..."
ssh -N -f "$HOST"
sleep 1

# Verify tunnel works
if ! ssh "$HOST" 'curl -s --connect-timeout 3 http://localhost:4004/' >/dev/null 2>&1; then
    echo "[$HOST] ERROR: tunnel still broken — port 4004 not reachable"
    echo "[$HOST] Try: ssh $HOST 'fuser -k 4004/tcp' then re-run"
    exit 1
fi
echo "[$HOST] Tunnel OK"

# Restart agent: kill old session if present, start fresh
echo "[$HOST] Restarting portolan-agent..."
ssh "$HOST" "tmux kill-session -t portolan-agent 2>/dev/null; true"
ssh "$HOST" "tmux new-session -d -s portolan-agent 'bash -l -c \"node ~/.local/bin/portolan-agent.js connect --ssh-host=$HOST\"'"
sleep 2

# Verify agent connected
if ssh "$HOST" "tmux capture-pane -t portolan-agent -p" 2>/dev/null | grep -q "Connected"; then
    echo "[$HOST] Agent connected"
else
    echo "[$HOST] WARNING: agent may not have connected — check: ssh $HOST 'tmux attach -t portolan-agent'"
fi
