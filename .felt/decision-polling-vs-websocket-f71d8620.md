---
title: 'Decision: polling vs WebSocket for conversation updates'
status: closed
kind: decision
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T03:26:32.733528+01:00
closed-at: 2026-01-31T03:26:32.733531+01:00
close-reason: 'Chose 3-second HTTP polling for initial conversation sync. Simpler than WebSocket push - no need to modify server broadcast logic. Trade-off: slightly higher latency and server load, but conversation content changes infrequently (only when Claude responds). Can upgrade to WebSocket push later if needed.'
---
