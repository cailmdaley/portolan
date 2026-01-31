---
title: 'Pattern: remote transcript sync via WebSocket'
status: closed
kind: doc
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
    - pattern-hexarchy-remote-content-8180cf9d
created-at: 2026-01-31T05:37:29.467802+01:00
closed-at: 2026-01-31T05:37:29.467816+01:00
close-reason: |-
    Remote Claude Code sessions need transcript syncing because:
    1. TranscriptReader runs on server, but transcripts are on remote machine
    2. agent.js already runs on remote and syncs activities
    3. Solution: agent.js reads ~/.claude/projects/ transcripts and sends agent_conversation messages
    4. Server caches in remoteConversations Map keyed by sessionId
    5. /conversation endpoint checks originId - local reads files, remote uses cache

    Files: server/agent.js (transcript reading), server/src/index.ts (cache), server/src/HttpApi.ts (lookup)
---
