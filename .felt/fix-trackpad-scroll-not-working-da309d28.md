---
title: 'Fix: trackpad scroll not working in worker panel'
status: closed
kind: task
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T04:09:33.719065+01:00
closed-at: 2026-01-31T04:10:41.709479+01:00
close-reason: 'Fixed nested scroll containers: worker-panel now uses flexbox with overflow:hidden, conversation-section is the sole scrollable container with flex:1. Scrollbar styles moved to target .conversation-section. Updated scrollTop in TS to scroll parent section.'
---
