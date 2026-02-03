---
title: Stable expanded state via timestamps
status: closed
kind: decision
priority: 2
depends-on:
    - chat-ui-full-messages-collapsed-aab0c273
created-at: 2026-02-01T23:11:47.795411+01:00
closed-at: 2026-02-01T23:11:47.795416+01:00
close-reason: Expanded message state used array indices as keys. When new messages arrived, indices shifted and expanded items collapsed. Changed to using msg.timestamp as stable key. Tool groups use 'group-{firstMsg.timestamp}'. Scroll position now preserved — only auto-scroll on initial render.
---
