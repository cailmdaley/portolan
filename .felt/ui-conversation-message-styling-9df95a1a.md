---
title: 'UI: conversation message styling - full width with accent borders'
status: closed
kind: decision
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T18:28:13.018684+01:00
closed-at: 2026-01-31T18:28:13.01869+01:00
close-reason: |-
    Removed left/right offset positioning for user/assistant messages. Now both are full-width with:
    - User: sepia accent border on RIGHT, gradient from right
    - Assistant: verdigris accent border on left, gradient from left
    - Text constrained to max-width 88ch for readability
    - Font sizes increased: messages 1.05rem, thinking 1rem, tool badges 0.85rem
    - Opacity increased on tool items (0.9) and thinking blocks (0.85) for better readability

    Panel width increased to min(50vw, 54rem) to accommodate larger text.
---
