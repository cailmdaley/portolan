---
title: 'Iteration 9: improve no-transcript UX'
status: closed
kind: task
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T05:30:40.697428+01:00
closed-at: 2026-01-31T05:37:01.862439+01:00
close-reason: |-
    Implemented remote worker conversation sync:

    1. agent.js: Added transcript reading (escapePathForClaude, findLatestTranscript, parseTranscriptEvent, extractUserContent, readTranscript) - mirrors TranscriptReader.ts but in plain JS for remote execution
    2. agent.js: Added conversation polling every 5s - sends agent_conversation messages to server
    3. MessageRouter.ts: Added AgentConversationMessage type
    4. index.ts: Added remoteConversations cache (Map<sessionId, messages[]>), handles agent_conversation messages
    5. HttpApi.ts: Updated /conversation endpoint to check remote cache for remote sessions (originId !== 'local')

    Now remote workers will sync their Claude Code transcripts to hexarchy server, enabling conversation display in WorkerActivityPanel for remote workers.
---
