---
title: 'Gotcha: timestamp precision varies across sources'
status: closed
kind: spec
priority: 2
depends-on:
    - fix-remote-chat-updates-c688a85d
created-at: 2026-02-04T16:27:45.275303+01:00
closed-at: 2026-02-04T16:27:45.275307+01:00
close-reason: 'Hooks generate timestamps via shell ''date'' (no ms). Transcripts have ISO timestamps with ms. Server deduplication must normalize to seconds before comparing. Fixed in ConversationCache.ts: normalizeTimestamp() truncates .\d{3}Z to Z.'
---
