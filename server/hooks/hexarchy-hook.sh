#!/bin/bash
# Hexarchy Hook - Captures Claude Code events for activity tracking
#
# Writes events to ~/.hexarchy/data/events.jsonl for the hexarchy-v2 server.
# Tracks working/idle status based on Claude activity.
#
# Install via: scripts/install-remote.sh <ssh-host>

set -e

# Config
HEXARCHY_DATA_DIR="${HEXARCHY_DATA_DIR:-$HOME/.hexarchy/data}"
EVENTS_FILE="${HEXARCHY_EVENTS_FILE:-$HEXARCHY_DATA_DIR/events.jsonl}"
mkdir -p "$(dirname "$EVENTS_FILE")"

# Find jq
JQ=$(command -v jq 2>/dev/null || echo "/opt/homebrew/bin/jq")
[ ! -x "$JQ" ] && JQ="/usr/local/bin/jq"
[ ! -x "$JQ" ] && exit 0  # Skip silently if no jq

# Get tmux session
tmux_session=""
[ -n "$TMUX" ] && tmux_session=$(tmux display-message -p '#S' 2>/dev/null || echo "")

# Timestamp (macOS compatible)
if command -v perl &>/dev/null; then
  timestamp=$(perl -MTime::HiRes=time -e 'printf "%.0f", time * 1000')
else
  timestamp=$(($(date +%s) * 1000))
fi

# Single jq call: parse input, map event type, build output JSON
"$JQ" -c --arg ts "$timestamp" --arg tmux "$tmux_session" '
  # Map hook event name to event type (PostToolUse excluded - unused by server)
  def map_event_type:
    if . == "PreToolUse" then "pre_tool_use"
    elif . == "Stop" then "stop"
    elif . == "SubagentStop" then "subagent_stop"
    elif . == "SessionStart" then "session_start"
    elif . == "SessionEnd" then "session_end"
    elif . == "UserPromptSubmit" then "user_prompt_submit"
    elif . == "Notification" then "notification"
    else null
    end;

  # Extract fields
  (.hook_event_name // "unknown") as $hook |
  ($hook | map_event_type) as $event_type |
  (.session_id // "unknown") as $session_id |

  # Skip unknown event types
  if $event_type == null then empty
  else
    # Build event object
    {
      id: "\($session_id)-\($ts)-\(now * 1000 | floor % 100000)",
      timestamp: ($ts | tonumber),
      type: $event_type,
      sessionId: $session_id,
      cwd: (.cwd // ""),
      tmuxSession: $tmux
    } + (
      if .tool_name then
        { tool: .tool_name, toolInput: (.tool_input // null) }
      elif .prompt then
        { prompt: .prompt }
      else {}
      end
    )
  end
' >> "$EVENTS_FILE"

exit 0
