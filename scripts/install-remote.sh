#!/bin/bash
# Install portolan agent and hooks on a remote machine.
#
# Usage: ./scripts/install-remote.sh <ssh-host> [--start] [--agent-runtime node|rust] [options]
#
# This script:
# 1. Copies portolan-hook.sh to remote ~/.portolan/hooks/
# 2. Copies agent.js to remote ~/.local/bin/portolan-agent.js (Node fallback, always kept)
# 3. Optionally copies Rust preview binary to remote ~/.local/bin/portolan-agent-rust
# 4. Creates ~/.portolan/data/ directory
# 5. Patches ~/.claude/settings.json to add:
#    - command hooks for canonical Portolan activity and file-touch tracking
# 6. Optionally starts a runtime in a tmux session
#
# Prerequisites on remote:
# - jq (for JSON patching)
# - tmux (for running agent)
# - Claude Code installed
# - Node.js with npm (optional for Rust preview, but used to keep Node fallback ready)

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
AGENT_RUNTIME="node"
RUST_AGENT_LOCAL_BINARY=""
RUST_AGENT_SESSION="portolan-agent-rust-preview"
NODE_AGENT_SESSION="portolan-agent"

usage() {
  cat <<EOF
Usage: $0 <ssh-host> [--start] [--agent-runtime node|rust] [options]

Options:
  --start                 Start one runtime in tmux after installation
  --agent-runtime VALUE   node or rust (default: node)
  --agent-binary PATH     Local path to rust binary (defaults to crates/portolan-agent/target/release/portolan-agent-rust)
  --agent-session NAME    Override tmux session name for rust preview runtime
  --help, -h              Show usage

Prerequisites on remote:
  - jq
  - tmux
  - Claude Code
  - Node.js + npm (optional for rust preview, but used to keep Node fallback ready)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --start)
      START_AGENT=true
      shift
      ;;
    --agent-runtime)
      if [ "$#" -lt 2 ]; then
        error "Missing value for --agent-runtime"
        exit 1
      fi
      AGENT_RUNTIME="$2"
      shift 2
      ;;
    --agent-runtime=*)
      AGENT_RUNTIME="${1#*=}"
      shift
      ;;
    --agent-binary)
      if [ "$#" -lt 2 ]; then
        error "Missing value for --agent-binary"
        exit 1
      fi
      RUST_AGENT_LOCAL_BINARY="$2"
      shift 2
      ;;
    --agent-binary=*)
      RUST_AGENT_LOCAL_BINARY="${1#*=}"
      shift
      ;;
    --agent-session)
      if [ "$#" -lt 2 ]; then
        error "Missing value for --agent-session"
        exit 1
      fi
      RUST_AGENT_SESSION="$2"
      shift 2
      ;;
    --agent-session=*)
      RUST_AGENT_SESSION="${1#*=}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      error "Unknown option: $1"
      exit 1
      ;;
    *)
      if [ -z "$SSH_HOST" ]; then
        SSH_HOST="$1"
      else
        error "Unexpected extra argument: $1"
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$SSH_HOST" ]; then
  error "Usage: $0 <ssh-host> [--start]"
  exit 1
fi

if [ "$AGENT_RUNTIME" != "node" ] && [ "$AGENT_RUNTIME" != "rust" ]; then
  error "Invalid --agent-runtime value: $AGENT_RUNTIME (must be node or rust)"
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
ssh "$SSH_HOST" "bash -lc 'set -e
missing=\"\"
command -v jq >/dev/null 2>&1 || missing=\"\$missing jq\"
command -v tmux >/dev/null 2>&1 || missing=\"\$missing tmux\"
[ -d ~/.claude ] || missing=\"\$missing claude-code\"
if [ \"$AGENT_RUNTIME\" = \"node\" ]; then
  command -v node >/dev/null 2>&1 || missing=\"\$missing node\"
fi
if [ -n \"\$missing\" ]; then
  echo \"Missing:\$missing\"
  exit 1
fi
echo ok'"

# Create directories on remote
log "Creating directories..."
ssh "$SSH_HOST" "mkdir -p ~/.portolan/hooks ~/.portolan/data ~/.portolan/bin ~/.local/bin"

# Copy files
log "Copying portolan-hook.sh..."
scp -q "$REPO_DIR/server/hooks/portolan-hook.sh" "$SSH_HOST:~/.portolan/hooks/"
ssh "$SSH_HOST" "chmod +x ~/.portolan/hooks/portolan-hook.sh"

log "Copying agent.js..."
scp -q "$REPO_DIR/server/agent.js" "$SSH_HOST:~/.local/bin/portolan-agent.js"

if [ "$AGENT_RUNTIME" = "rust" ]; then
  log "Copying Rust preview agent..."
  RUST_AGENT_LOCAL_BINARY="${RUST_AGENT_LOCAL_BINARY:-$REPO_DIR/crates/portolan-agent/target/release/portolan-agent-rust}"
  if [ ! -f "$RUST_AGENT_LOCAL_BINARY" ]; then
    error "Rust agent binary not found: $RUST_AGENT_LOCAL_BINARY"
    error "Run: npm run native:agent, or for Linux remotes run npm run native:agent:linux and pass --agent-binary crates/portolan-agent/target/x86_64-unknown-linux-gnu/release/portolan-agent-rust"
    exit 1
  fi
  scp -q "$RUST_AGENT_LOCAL_BINARY" "$SSH_HOST:~/.local/bin/portolan-agent-rust"
  ssh "$SSH_HOST" "chmod +x ~/.local/bin/portolan-agent-rust"
fi

# Older Portolan agents used a bundled TS Shuttle worker. The standalone
# Shuttle cutover removed that script; keep install compatible with older
# checkouts without failing current agent installs.
if [ -f "$REPO_DIR/server/src/shuttle-worker.sh" ]; then
  log "Copying shuttle-worker.sh..."
  scp -q "$REPO_DIR/server/src/shuttle-worker.sh" "$SSH_HOST:~/.portolan/bin/"
  ssh "$SSH_HOST" "chmod +x ~/.portolan/bin/shuttle-worker.sh"
else
  warn "shuttle-worker.sh not present; skipping retired TS Shuttle worker install"
  ssh "$SSH_HOST" "rm -f ~/.portolan/bin/shuttle-worker.sh"
fi

# Install ws dependency for the Node fallback whenever Node is available. Rust
# preview installs should leave `portolan-agent` restartable without a second
# install pass.
if ssh "$SSH_HOST" 'bash -l -c "command -v node >/dev/null 2>&1"'; then
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
elif [ "$AGENT_RUNTIME" = "rust" ]; then
  warn "Node not found on remote; Rust preview can run, but Node fallback is not startable until Node is installed"
fi

# Patch Claude settings
log "Patching Claude settings..."
ssh "$SSH_HOST" bash <<'PATCH_SETTINGS'
set -e
SETTINGS_FILE=~/.claude/settings.json
HOOK_PATH="$HOME/.portolan/hooks/portolan-hook.sh"

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
ssh "$SSH_HOST" bash <<VERIFY
echo "  Hook: \$(ls ~/.portolan/hooks/portolan-hook.sh 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "  Agent: \$(ls ~/.local/bin/portolan-agent.js 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "  Rust Agent: \$(ls ~/.local/bin/portolan-agent-rust 2>/dev/null && echo 'OK' || echo 'NOT PROVIDED')"
echo "  Retired TS Shuttle worker removed: \$([ ! -e ~/.portolan/bin/shuttle-worker.sh ] && echo 'OK' || echo 'STALE')"
if command -v node >/dev/null 2>&1; then
  echo "  ws: \$(ls ~/.local/bin/node_modules/ws 2>/dev/null && echo 'OK' || echo 'MISSING')"
fi
echo "  Settings: \$(grep -q portolan-hook ~/.claude/settings.json 2>/dev/null && echo 'OK' || echo 'NOT CONFIGURED')"
echo "  PostToolUse JSONL hook: \$(jq -e '[.hooks.PostToolUse[]? | select((.matcher // \"\") == \"Read|Write|Edit\") | (.hooks // [])[]? | select(.type == \"command\" and (.command | test(\"portolan-hook.sh$\")))] | length > 0' ~/.claude/settings.json >/dev/null 2>&1 && echo 'OK' || echo 'NOT CONFIGURED')"
VERIFY

log "Checking remote tunnel and canonical hook output..."
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

    probe_session="remote-hook-probe-$(date +%s)"
    probe_path="/tmp/portolan-remote-hook-probe.ts"
    probe_payload="$(printf '{"hook_event_name":"PostToolUse","session_id":"%s","tool_name":"Read","tool_input":{"file_path":"%s"},"cwd":"/tmp"}' "$probe_session" "$probe_path")"
    escaped_probe_payload="$(printf "%s" "$probe_payload" | sed "s/'/'\\\\''/g")"
    probe_response="$(ssh "$SSH_HOST" "PROBE_PAYLOAD='$escaped_probe_payload' bash -s" <<'REMOTE_HOOK_PROBE' 2>/dev/null || true
set -e
tmp_events="$(mktemp)"
trap 'rm -f "$tmp_events"' EXIT
printf '%s' "$PROBE_PAYLOAD" | PORTOLAN_EVENTS_FILE="$tmp_events" ~/.portolan/hooks/portolan-hook.sh
tail -n 1 "$tmp_events"
REMOTE_HOOK_PROBE
)"

    if command -v jq >/dev/null 2>&1 && echo "$probe_response" | jq -e --arg session "$probe_session" --arg path "$probe_path" '.type == "post_tool_use" and .harness == "claude-code" and .sessionId == $session and .tool == "Read" and .toolInput.file_path == $path' >/dev/null 2>&1; then
      log "Hook check: remote command hook wrote canonical JSONL"
    else
      warn "Hook check failed. Event: ${probe_response:-<empty>}"
      warn "Verify ~/.portolan/hooks/portolan-hook.sh is executable and jq is installed on $SSH_HOST"
    fi
  fi
fi

# Start agent if requested
if [ "$START_AGENT" = true ]; then
  log "Starting agent..."
  if [ "$AGENT_RUNTIME" = "rust" ]; then
    AGENT_SESSION="$RUST_AGENT_SESSION"
    AGENT_CMD="~/.local/bin/portolan-agent-rust connect --ssh-host=$SSH_HOST"
  else
    AGENT_SESSION="$NODE_AGENT_SESSION"
    AGENT_CMD="node ~/.local/bin/portolan-agent.js connect --ssh-host=$SSH_HOST"
  fi
  ssh "$SSH_HOST" bash <<STARTAGENT
    # Kill existing runtime-specific agent if running
    tmux kill-session -t "$AGENT_SESSION" 2>/dev/null || true
    # Start new agent session
    tmux new-session -d -s "$AGENT_SESSION" "bash -l -c '$AGENT_CMD'"
    echo "Agent started in tmux session '$AGENT_SESSION'"
STARTAGENT
fi

echo ""
log "Done! Next steps:"
echo "  1. Ensure the local launchd tunnel is installed:"
echo "       ./scripts/install-tunnels.sh $SSH_HOST"
echo "     Fallback without launchd:"
echo "       ./scripts/reset-tunnel.sh --manual $SSH_HOST"
echo ""
if [ "$AGENT_RUNTIME" = "rust" ]; then
  echo "  2. Start the Rust preview agent on remote (session kept separate):"
  echo "       ssh $SSH_HOST"
  echo "       tmux new-session -d -s '$RUST_AGENT_SESSION' \"bash -l -c '~/.local/bin/portolan-agent-rust connect --ssh-host=$SSH_HOST'\""
  echo ""
  echo "  3. Rust preview temporarily owns the origin socket while connected."
  echo "     Node fallback remains available in tmux session '$NODE_AGENT_SESSION' and reconnects after Rust exits:"
  echo "       tmux new-session -d -s '$NODE_AGENT_SESSION' \"bash -l -c 'node ~/.local/bin/portolan-agent.js connect --ssh-host=$SSH_HOST'\""
else
  echo "  2. Start the agent on remote (if not using --start):"
  echo "       ssh $SSH_HOST"
  echo "       tmux new-session -d -s $NODE_AGENT_SESSION \"bash -l -c 'node ~/.local/bin/portolan-agent.js connect --ssh-host=$SSH_HOST'\""
fi
echo "  4. Restart any existing Claude Code sessions to pick up hooks"
