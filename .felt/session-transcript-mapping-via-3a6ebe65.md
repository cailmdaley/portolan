---
title: Session-transcript mapping via lsof
status: closed
kind: decision
priority: 2
depends-on:
    - chat-ui-full-messages-collapsed-aab0c273
    - hexarchy-remote-agent-setup-ssh-b7ce007f
created-at: 2026-02-01T14:14:36.814973+01:00
closed-at: 2026-02-01T14:14:36.814973+01:00
close-reason: Use lsof to detect which transcript file a Claude process has open. Claude keeps ~/.claude/tasks/{uuid}/ directories open - the UUID matches the transcript filename. Works reliably even for idle sessions. Implemented in TranscriptReader.ts (local) and agent.js (remote). Mappings persisted to ~/.portolan/transcript-mappings.json. Added /debug-transcripts endpoint for inspection.
---

Problem: Multiple workers in same project directory all showed the same conversation (the most recent transcript). Timing-based detection only worked when activity was happening.
