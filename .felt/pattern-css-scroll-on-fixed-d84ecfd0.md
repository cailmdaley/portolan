---
title: 'Pattern: CSS scroll on fixed panels'
status: closed
kind: spec
priority: 2
created-at: 2026-01-31T04:08:12.369248+01:00
closed-at: 2026-01-31T04:08:12.369301+01:00
close-reason: |-
    For fixed-position panels with overflow-y: scroll, also need:
    - -webkit-overflow-scrolling: touch (trackpad smoothness)
    - overscroll-behavior: contain (keep scroll within panel)
    - pointer-events: none on ::before pseudo-elements
    - z-index on resize handles to avoid blocking content
---
