#!/bin/bash
# Portolan Codex hook adapter.
#
# Install from ~/.codex/hooks.json for PreToolUse/PostToolUse/UserPromptSubmit/
# Stop as needed. Codex passes one JSON object on stdin; this adapter writes
# the canonical Portolan JSONL event consumed by EventWatcher.

set -e

PORTOLAN_DATA_DIR="${PORTOLAN_DATA_DIR:-$HOME/.portolan/data}"
EVENTS_FILE="${PORTOLAN_EVENTS_FILE:-$PORTOLAN_DATA_DIR/events.jsonl}"
mkdir -p "$(dirname "$EVENTS_FILE")"

JQ=$(command -v jq 2>/dev/null || echo "/opt/homebrew/bin/jq")
[ ! -x "$JQ" ] && JQ="/usr/local/bin/jq"
[ ! -x "$JQ" ] && exit 0

tmux_session=""
[ -n "$TMUX" ] && tmux_session=$(tmux display-message -p '#S' 2>/dev/null || echo "")

if command -v perl &>/dev/null; then
  timestamp=$(perl -MTime::HiRes=time -e 'printf "%.0f", time * 1000')
else
  timestamp=$(($(date +%s) * 1000))
fi

input=$(cat)
[ -z "$input" ] && exit 0

payload=$(printf '%s' "$input" | "$JQ" -c --arg ts "$timestamp" --arg tmux "$tmux_session" --arg origin "$(hostname)" '
  def map_event_type:
    if . == "PreToolUse" then "pre_tool_use"
    elif . == "PostToolUse" then "post_tool_use"
    elif . == "Stop" then "stop"
    elif . == "SessionStart" then "session_start"
    elif . == "SessionEnd" then "session_end"
    elif . == "UserPromptSubmit" then "user_prompt_submit"
    elif . == "Notification" then "notification"
    else null
    end;

  def normalize_tool:
    if . == "Read" or . == "read_file" or . == "ReadFile" then "Read"
    elif . == "Write" or . == "write_file" or . == "WriteFile" then "Write"
    elif . == "Edit" or . == "edit_file" or . == "apply_patch" then "Edit"
    else .
    end;

  def canonical_path($cwd):
    if type == "string" and length > 0 then
      if startswith("/") then .
      elif ($cwd | type) == "string" and ($cwd | length) > 0 then
        "\($cwd | sub("/$"; ""))/\(.)"
      else .
      end
    else empty
    end;

  def explicit_file_path:
    .file_path // .path // .filePath // .absolute_path // empty;

  def apply_patch_paths:
    (.command // "") as $command |
    if ($command | type) == "string" then
      $command
      | split("\n")
      | map(capture("^\\*\\*\\* (?:Add|Update|Delete) File: (?<path>.+)$")? | .path)
      | unique
    else []
    end;

  (.hook_event_name // "unknown") as $hook |
  ($hook | map_event_type) as $event_type |
  (.session_id // "unknown") as $session_id |
  if $event_type == null then empty
  else
    ({
      id: "codex-\($session_id)-\($ts)-\(now * 1000 | floor % 100000)",
      timestamp: ($ts | tonumber),
      type: $event_type,
      sessionId: $session_id,
      cwd: (.cwd // ""),
      tmuxSession: $tmux,
      harness: "codex",
      originName: $origin
    }) as $base |
    $base + (
      if .tool_name then
        (.tool_input // {}) as $tool_input |
        (.tool_name | normalize_tool) as $tool |
        (.cwd // "") as $cwd |
        (
          [$tool_input | explicit_file_path | canonical_path($cwd)]
          + if .tool_name == "apply_patch" then [$tool_input | apply_patch_paths[] | canonical_path($cwd)] else [] end
          | unique
        ) as $file_paths |
        if ($file_paths | length) > 0 then
          $file_paths[]
          | { tool: $tool, toolInput: ($tool_input + { file_path: . }) }
        else
          { tool: $tool, toolInput: $tool_input }
        end
      elif .prompt then
        { prompt: .prompt }
      else {}
      end
    )
  end
' 2>/dev/null || true)

[ -z "$payload" ] && exit 0
printf '%s\n' "$payload" >> "$EVENTS_FILE"

exit 0
