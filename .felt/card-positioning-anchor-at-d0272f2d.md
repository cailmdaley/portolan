---
title: 'Card positioning: anchor at swarm top, not center'
status: closed
kind: decision
priority: 2
depends-on:
    - murmuration-workers-68674cb9
created-at: 2026-02-04T02:24:04.307469+01:00
closed-at: 2026-02-04T02:24:04.307474+01:00
close-reason: 'Cards were inconsistently positioned because saved card heights varied (150px-600px) and percentage-based transforms (translateY -50%) shifted different heights by different amounts. Fix: anchor CSS2D object at y=0.7 (above swarm), use transform-origin center bottom, translateY(-50%). Card bottom now consistently at anchor regardless of height.'
---
