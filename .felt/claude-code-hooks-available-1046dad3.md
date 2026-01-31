---
title: 'Claude Code hooks: available event data and conversation sources'
status: closed
kind: spec
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T02:36:22.221169+01:00
closed-at: 2026-01-31T02:36:22.221171+01:00
close-reason: |-
    **Claude Code hook events** (from hexarchy-hook.sh):
    - `UserPromptSubmit` → `prompt` field has user message text
    - `PreToolUse` → `tool_name` + `tool_input`
    - `PostToolUse` → same + `tool_response`
    - `Stop`, `SessionStart`, `SessionEnd` → lifecycle only

    **NOT available via hooks:**
    - Assistant response text
    - Thinking block content
    - Streaming content

    **Alternative: session transcript files**
    `~/.claude/projects/{project-path}/{session-uuid}.jsonl` contains:
    - `type: 'user'` → user messages with `message.content`
    - `type: 'assistant'` → assistant responses (streaming, multiple entries)
    - `type: 'progress'` → hook execution logs

    To get full conversation, read transcript files directly (path available in hooks as `transcript_path`).
---
