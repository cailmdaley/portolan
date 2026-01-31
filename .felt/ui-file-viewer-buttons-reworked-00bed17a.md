---
title: 'UI: file viewer buttons reworked for parchment theme'
status: closed
kind: decision
priority: 2
depends-on:
    - ui-conversation-message-styling-9df95a1a
created-at: 2026-01-31T23:36:19.782625+01:00
closed-at: 2026-01-31T23:36:19.78263+01:00
close-reason: |-
    Replaced bright dark-mode button colors with warm parchment palette:
    - Base buttons: parchment-light bg, ink text, parchment-edge border
    - File as Fiber: sepia/gold gradient (rgba 138,107,42), sepia-accent border
    - Send to Worker: verdigris gradient (rgba 74,98,88), verdigris border
    - Save: muted olive green (rgba 90,107,80), ui-green border
    - Annotation save/cancel: same sepia style
    - Close: ink-faded → rust on hover
    - Worker picker items: sepia-accent border on hover

    All buttons now use font-family: var(--font-main) for consistency.
---
