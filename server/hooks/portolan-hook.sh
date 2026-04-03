#!/bin/bash
# Portolan Hook - Captures Claude Code events for activity tracking
#
# Writes events to ~/.portolan/data/events.jsonl for the portolan server.
# Tracks working/idle status based on Claude activity.
#
# Install via: scripts/install-remote.sh <ssh-host>

set -e

# Config
PORTOLAN_DATA_DIR="${PORTOLAN_DATA_DIR:-$HOME/.portolan/data}"
EVENTS_FILE="${PORTOLAN_EVENTS_FILE:-$PORTOLAN_DATA_DIR/events.jsonl}"
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

# Read hook payload once so we can branch on the raw hook event.
input=$(cat)
[ -z "$input" ] && exit 0

raw_hook_name=$(printf '%s' "$input" | "$JQ" -r '.hook_event_name // empty' 2>/dev/null || true)

if [ "$raw_hook_name" = "PostToolUse" ]; then
  forward_payload=$(printf '%s' "$input" | "$JQ" -c --arg tmux "$tmux_session" --arg origin "$(hostname)" '
    select((.tool_name // "") | test("^(Read|Write|Edit)$")) |
    . + { tmux_session: $tmux, origin_name: $origin }
  ' 2>/dev/null || true)
  if [ -n "$forward_payload" ]; then
    curl -sS -m 2 -X POST http://localhost:4004/hook/file-touch \
      -H 'Content-Type: application/json' \
      -d "$forward_payload" >/dev/null 2>&1 || true
  fi
  exit 0
fi

if [ "$raw_hook_name" = "Stop" ]; then
  transcript_path=$(printf '%s' "$input" | "$JQ" -r '.transcript_path // empty' 2>/dev/null || true)
  session_id=$(printf '%s' "$input" | "$JQ" -r '.session_id // empty' 2>/dev/null || true)
  cwd=$(printf '%s' "$input" | "$JQ" -r '.cwd // empty' 2>/dev/null || true)
  origin_name=$(hostname)

  if [ -n "$transcript_path" ] && [ -f "$transcript_path" ] && [ -n "$session_id" ]; then
    assistant_payload=$(tail -100 "$transcript_path" | "$JQ" -cs \
      --arg session_id "$session_id" \
      --arg cwd "$cwd" \
      --arg tmux "$tmux_session" \
      --arg origin "$origin_name" \
      --arg transcript_path "$transcript_path" '
      [
        .[]
        | select(.type == "assistant")
        | . as $entry
        | ($entry.message.content // [])
        | to_entries[]
        | select(.value.type == "text")
        | select((.value.text // "") != "")
        | {
            sourceKey: "\(($entry.timestamp // "assistant"))#\(.key)",
            timestamp: ($entry.timestamp // null),
            text: .value.text
          }
      ] as $responses
      | select(($responses | length) > 0)
      | {
          session_id: $session_id,
          cwd: $cwd,
          tmux_session: $tmux,
          origin_name: $origin,
          transcript_path: $transcript_path,
          responses: $responses
        }
    ' 2>/dev/null || true)

    if [ -n "$assistant_payload" ]; then
      curl -sS -m 2 -X POST http://localhost:4004/hook/assistant-turn \
        -H 'Content-Type: application/json' \
        -d "$assistant_payload" >/dev/null 2>&1 || true
    fi
  fi
fi

payload=$(printf '%s' "$input" | "$JQ" -c --arg ts "$timestamp" --arg tmux "$tmux_session" '
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
')

if [ -z "$payload" ]; then
  exit 0
fi

printf '%s\n' "$payload" >> "$EVENTS_FILE"

exit 0
