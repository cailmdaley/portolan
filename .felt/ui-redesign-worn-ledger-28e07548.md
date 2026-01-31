---
title: 'UI redesign: worn ledger parchment aesthetic'
status: closed
kind: task
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T04:00:01.575076+01:00
closed-at: 2026-01-31T04:04:36.50146+01:00
close-reason: |-
    Implemented worn ledger parchment aesthetic for both panels:

    **Palette changes:**
    - New CSS variables: --parchment-base, --ink-dark, --sepia-accent, --verdigris, --rust
    - Warmer brown-beige tones replacing bright parchment
    - Better contrast with dedicated ink colors for text

    **Worker panel:**
    - Removed Claude/You badges per user request
    - Larger thinking text (0.85rem), removed 'Thinking' label
    - Simplified message bubbles with left border accent
    - Updated conversation list, tool items, thinking blocks

    **City panel:**
    - Matched background gradient to worker panel
    - Updated search input, tabs, fiber items to new palette
    - Simplified borders and hover states

    **Both panels:**
    - Now 1/3 width each (calc(100vw / 3))
    - Claims/playground modals now nearly full-screen (2vh/2vw margins)
    - Consistent scrollbar styling
---
