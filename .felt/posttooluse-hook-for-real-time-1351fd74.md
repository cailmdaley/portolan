---
title: PostToolUse hook for real-time conversation updates
status: closed
kind: decision
priority: 2
depends-on:
    - hook-based-conversation-capture-52030153
created-at: 2026-02-06T11:45:41.019593+01:00
closed-at: 2026-02-06T11:45:41.019596+01:00
close-reason: 'Added PostToolUse to portolan-conversation-hook.sh for mid-turn tool call streaming. Constructs tool_use + tool_result messages directly from event payload (no transcript scan). Combined with toolUseId-based dedup in ConversationCache so Stop doesn''t re-add the same tool calls. Coverage: UserPromptSubmit (user message, instant) → PostToolUse (tool calls, real-time) → Stop (assistant text + thinking, end of turn). Also added to PostToolUse hook config in settings.json.'
---
