#!/bin/bash
# Install hexarchy agent and hooks on a remote machine
#
# Usage: ./scripts/install-remote.sh <ssh-host> [--start]
#
# This script:
# 1. Copies hexarchy-hook.sh to remote ~/.hexarchy/hooks/
# 2. Copies agent.js to remote ~/bin/hexarchy-agent.js
# 3. Creates ~/.hexarchy/data/ directory
# 4. Patches ~/.claude/settings.json to add hook entries
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

log() { echo -e "${GREEN}[hexarchy]${NC} $1"; }
warn() { echo -e "${YELLOW}[hexarchy]${NC} $1"; }
error() { echo -e "${RED}[hexarchy]${NC} $1" >&2; }

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

log "Installing hexarchy on $SSH_HOST..."

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
ssh "$SSH_HOST" "mkdir -p ~/.hexarchy/hooks ~/.hexarchy/data ~/bin"

# Copy files
log "Copying hexarchy-hook.sh..."
scp -q "$REPO_DIR/server/hooks/hexarchy-hook.sh" "$SSH_HOST:~/.hexarchy/hooks/"
ssh "$SSH_HOST" "chmod +x ~/.hexarchy/hooks/hexarchy-hook.sh"

log "Copying agent.js..."
scp -q "$REPO_DIR/server/agent.js" "$SSH_HOST:~/bin/hexarchy-agent.js"

# Install ws dependency for agent (use login shell for nvm)
log "Installing ws package..."
ssh "$SSH_HOST" 'bash -l -c '\''
cd ~/bin
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
HOOK_PATH="$HOME/.hexarchy/hooks/hexarchy-hook.sh"

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

# Write back
echo "$current" | jq '.' > "$SETTINGS_FILE"
echo "Settings updated"
PATCH_SETTINGS

log "Installation complete!"

# Verify installation
log "Verifying..."
ssh "$SSH_HOST" bash <<'VERIFY'
echo "  Hook: $(ls ~/.hexarchy/hooks/hexarchy-hook.sh 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "  Agent: $(ls ~/bin/hexarchy-agent.js 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "  ws: $(ls ~/bin/node_modules/ws 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "  Settings: $(grep -q hexarchy-hook ~/.claude/settings.json 2>/dev/null && echo 'OK' || echo 'NOT CONFIGURED')"
VERIFY

# Start agent if requested
if [ "$START_AGENT" = true ]; then
  log "Starting agent..."
  ssh "$SSH_HOST" bash <<STARTAGENT
    # Kill existing agent if running
    tmux kill-session -t hexarchy-agent 2>/dev/null || true
    # Start new agent session
    tmux new-session -d -s hexarchy-agent "bash -l -c 'node ~/bin/hexarchy-agent.js connect --ssh-host=$SSH_HOST'"
    echo "Agent started in tmux session 'hexarchy-agent'"
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
echo "       tmux new-session -d -s hexarchy-agent 'node ~/bin/hexarchy-agent.js connect --ssh-host=$SSH_HOST'"
echo ""
echo "  3. Restart any existing Claude Code sessions to pick up hooks"
