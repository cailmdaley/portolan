---
title: Claude Code hook payloads for conversation capture
status: closed
kind: question
priority: 2
depends-on:
    - hook-based-conversation-capture-52030153
created-at: 2026-02-03T04:12:10.205895+01:00
closed-at: 2026-02-03T04:12:10.2059+01:00
close-reason: 'UserPromptSubmit: { session_id, cwd, prompt } - prompt contains user message directly. Stop: { session_id, cwd, transcript_path, stop_hook_active } - must parse transcript_path tail for assistant response. No hook provides assistant response directly (GitHub issue #10610 closed as duplicate, feature not implemented).'
---
