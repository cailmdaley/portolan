#!/bin/bash
# Install portolan agent and hooks on a remote machine
#
# Usage: ./scripts/install-remote.sh <ssh-host> [--start]
#
# This script:
# 1. Copies portolan-hook.sh to remote ~/.portolan/hooks/
# 2. Copies agent.js to remote ~/.local/bin/portolan-agent.js
# 3. Creates ~/.portolan/data/ directory
# 4. Patches ~/.claude/settings.json to add:
#    - command hooks for portolan activity tracking
#    - PostToolUse HTTP hook for file-touch forwarding
# 5. Optionally starts the agent in a tmux session
#
# Prerequisites on remote:
# - Node.js with npm
# - jq (for JSON patching)
# - tmux (for running agent)
# - Claude Code installed

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[portolan]${NC} $1"; }
warn() { echo -e "${YELLOW}[portolan]${NC} $1"; }
error() { echo -e "${RED}[portolan]${NC} $1" >&2; }

# Parse arguments
SSH_HOST=""
START_AGENT=false

for arg in "$@"; do
  case $arg in
    --start)
      START_AGENT=true
      ;;
    --help|-h)
      echo "Usage: $0 <ssh-host> [--start]"
      echo ""
      echo "Options:"
      echo "  --start    Start the agent in tmux after installation"
      echo ""
      echo "Prerequisites on remote:"
      echo "  - Node.js with npm"
      echo "  - jq"
      echo "  - tmux"
      echo "  - Claude Code"
      exit 0
      ;;
    *)
      if [ -z "$SSH_HOST" ]; then
        SSH_HOST="$arg"
      fi
      ;;
  esac
done

if [ -z "$SSH_HOST" ]; then
  error "Usage: $0 <ssh-host> [--start]"
  exit 1
fi

log "Installing portolan on $SSH_HOST..."

# Check SSH connectivity
log "Testing SSH connection..."
if ! ssh "$SSH_HOST" "echo ok" >/dev/null 2>&1; then
  error "Cannot connect to $SSH_HOST"
  exit 1
fi

# Check prerequisites on remote (use login shell for nvm)
log "Checking prerequisites..."
ssh "$SSH_HOST" 'bash -l -c '\''
set -e
missing=""
command -v node >/dev/null 2>&1 || missing="$missing node"
command -v jq >/dev/null 2>&1 || missing="$missing jq"
command -v tmux >/dev/null 2>&1 || missing="$missing tmux"
[ -d ~/.claude ] || missing="$missing claude-code"
if [ -n "$missing" ]; then
  echo "Missing:$missing"
  exit 1
fi
echo "ok"
'\'''

# Create directories on remote
log "Creating directories..."
ssh "$SSH_HOST" "mkdir -p ~/.portolan/hooks ~/.portolan/data ~/.portolan/bin ~/.local/bin"

# Copy files
log "Copying portolan-hook.sh..."
scp -q "$REPO_DIR/server/hooks/portolan-hook.sh" "$SSH_HOST:~/.portolan/hooks/"
ssh "$SSH_HOST" "chmod +x ~/.portolan/hooks/portolan-hook.sh"

log "Copying agent.js..."
scp -q "$REPO_DIR/server/agent.js" "$SSH_HOST:~/.local/bin/portolan-agent.js"

# Constitution shuttle-remote-dispatch: ship the shuttle worker script so
# the agent can dispatch its own constitution fibers locally on the host.
# The agent looks for it at ~/.portolan/bin/shuttle-worker.sh by default
# (overridable via PORTOLAN_SHUTTLE_WORKER).
log "Copying shuttle-worker.sh..."
scp -q "$REPO_DIR/server/src/shuttle-worker.sh" "$SSH_HOST:~/.portolan/bin/"
ssh "$SSH_HOST" "chmod +x ~/.portolan/bin/shuttle-worker.sh"

# Install ws dependency for agent (use login shell for nvm)
log "Installing ws package..."
ssh "$SSH_HOST" 'bash -l -c '\''
cd ~/.local/bin
if [ ! -f package.json ]; then
  echo "{\"type\": \"module\"}" > package.json
fi
# Ensure type: module is set
if ! grep -q "\"type\": \"module\"" package.json; then
  jq ". + {type: \"module\"}" package.json > package.json.tmp && mv package.json.tmp package.json
fi
if [ ! -d node_modules/ws ]; then
  npm install ws --save >/dev/null 2>&1
fi
'\'''

# Patch Claude settings
log "Patching Claude settings..."
ssh "$SSH_HOST" bash <<'PATCH_SETTINGS'
set -e
SETTINGS_FILE=~/.claude/settings.json
HOOK_PATH="$HOME/.portolan/hooks/portolan-hook.sh"
FILE_TOUCH_URL="http://localhost:4004/hook/file-touch"

# Create settings file if it doesn't exist
if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

# Read current settings
current=$(cat "$SETTINGS_FILE")

# Define the hook entry we want to add
hook_entry=$(jq -n --arg path "$HOOK_PATH" '[{"hooks": [{"type": "command", "command": $path}]}]')

# Function to add hook to an event if not already present
add_hook() {
  local event="$1"
  local settings="$2"

  # Check if hook already exists for this event
  existing=$(echo "$settings" | jq -r --arg path "$HOOK_PATH" --arg event "$event" '
    .hooks[$event] // [] | map(select(.hooks[0].command == $path)) | length
  ')

  if [ "$existing" = "0" ]; then
    # Add the hook
    settings=$(echo "$settings" | jq --arg event "$event" --argjson hook "$hook_entry" '
      .hooks[$event] = (.hooks[$event] // []) + $hook
    ')
  fi

  echo "$settings"
}

# Ensure hooks object exists
current=$(echo "$current" | jq '.hooks //= {}')

# Add hooks for each event type
for event in UserPromptSubmit PreToolUse Stop; do
  current=$(add_hook "$event" "$current")
done

# Ensure PostToolUse uses the command hook so remote file touches include tmux_session.
current=$(echo "$current" | jq --arg path "$HOOK_PATH" '
  .hooks.PostToolUse = (
    [{
      "matcher": "Read|Write|Edit",
      "hooks": [{ "type": "command", "command": $path }]
    }]
  )
')

# Write back
echo "$current" | jq '.' > "$SETTINGS_FILE"
echo "Settings updated"
PATCH_SETTINGS

log "Installation complete!"

# Verify installation
log "Verifying..."
ssh "$SSH_HOST" bash <<'VERIFY'
echo "  Hook: $(ls ~/.portolan/hooks/portolan-hook.sh 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "  Agent: $(ls ~/.local/bin/portolan-agent.js 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "  Shuttle worker: $(ls ~/.portolan/bin/shuttle-worker.sh 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "  ws: $(ls ~/.local/bin/node_modules/ws 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "  Settings: $(grep -q portolan-hook ~/.claude/settings.json 2>/dev/null && echo 'OK' || echo 'NOT CONFIGURED')"
echo "  File-touch hook: $(jq -e '[.hooks.PostToolUse[]? | select((.matcher // \"\") == \"Read|Write|Edit\") | (.hooks // [])[]? | select(.type == \"command\" and (.command | test(\"portolan-hook.sh$\")))] | length > 0' ~/.claude/settings.json >/dev/null 2>&1 && echo 'OK' || echo 'NOT CONFIGURED')"
VERIFY

log "Checking remote HTTP hook forwarding..."
if ! curl -sS -m 3 http://localhost:4004/debug-runtime >/dev/null 2>&1; then
  warn "Local portolan server not reachable at http://localhost:4004; skipping live forwarding probe"
else
  local_pid=""
  if command -v jq >/dev/null 2>&1; then
    local_pid="$(curl -sS -m 3 http://localhost:4004/debug-runtime | jq -r '.pid // empty' 2>/dev/null || true)"
  fi

  remote_debug="$(ssh "$SSH_HOST" "curl -sS -m 5 http://localhost:4004/debug-runtime" 2>/dev/null || true)"
  if [ -z "$remote_debug" ]; then
    warn "Remote could not reach localhost:4004 via SSH tunnel"
    warn "Verify SSH config includes: RemoteForward 4004 127.0.0.1:4004"
  else
    if [ -n "$local_pid" ] && command -v jq >/dev/null 2>&1; then
      remote_pid="$(echo "$remote_debug" | jq -r '.pid // empty' 2>/dev/null || true)"
      if [ -n "$remote_pid" ] && [ "$remote_pid" = "$local_pid" ]; then
        log "Tunnel check: remote localhost:4004 resolves to local server (pid $local_pid)"
      else
        warn "Tunnel check: remote /debug-runtime responded but pid did not match local server"
      fi
    else
      log "Tunnel check: remote /debug-runtime endpoint is reachable"
    fi

    probe_session="remote-forward-probe-$(date +%s)"
    probe_payload="$(printf '{"session_id":"%s","tool_name":"Read","tool_input":{"file_path":"/tmp/portolan-remote-forward-probe.ts"},"cwd":"/tmp"}' "$probe_session")"
    probe_response="$(ssh "$SSH_HOST" "curl -sS -m 5 -X POST http://localhost:4004/hook/file-touch -H 'Content-Type: application/json' -d @-" <<< "$probe_payload" 2>/dev/null || true)"

    if command -v jq >/dev/null 2>&1 && echo "$probe_response" | jq -e '.success == true' >/dev/null 2>&1; then
      log "Hook check: remote POST /hook/file-touch reached server"
    elif echo "$probe_response" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
      log "Hook check: remote POST /hook/file-touch reached server"
    else
      warn "Hook check failed. Response: ${probe_response:-<empty>}"
      warn "Verify SSH config includes: RemoteForward 4004 127.0.0.1:4004"
    fi
  fi
fi

# Start agent if requested
if [ "$START_AGENT" = true ]; then
  log "Starting agent..."
  ssh "$SSH_HOST" bash <<STARTAGENT
    # Kill existing agent if running
    tmux kill-session -t portolan-agent 2>/dev/null || true
    # Start new agent session
    tmux new-session -d -s portolan-agent "bash -l -c 'node ~/.local/bin/portolan-agent.js connect --ssh-host=$SSH_HOST'"
    echo "Agent started in tmux session 'portolan-agent'"
STARTAGENT
fi

echo ""
log "Done! Next steps:"
echo "  1. Ensure SSH tunnel is configured in local ~/.ssh/config:"
echo "       Host $SSH_HOST"
echo "         RemoteForward 4004 127.0.0.1:4004"
echo ""
echo "  2. Start the agent on remote (if not using --start):"
echo "       ssh $SSH_HOST"
echo "       tmux new-session -d -s portolan-agent 'node ~/.local/bin/portolan-agent.js connect --ssh-host=$SSH_HOST'"
echo ""
echo "  3. Restart any existing Claude Code sessions to pick up hooks"
