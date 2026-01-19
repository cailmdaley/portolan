---
title: 'Hexarchy: session name truncation for long tmux names'
status: closed
kind: decision
priority: 2
depends-on:
    - fireside-command-civ6-inspired-919b3ee0
created-at: 2026-01-19T09:15:09.659996+01:00
closed-at: 2026-01-19T09:15:19.080895+01:00
close-reason: 'Long tmux session names like ''ralph-global-views-map-plots-plans-3374f8fb'' overflow UI labels. Added truncateName() in SessionTracker.ts: ralph sessions become ''ralph-{hash}'' (e.g. ralph-3374f8fb), generic long names become ''first8…last8''. MAX_LENGTH=20. The full tmuxSession is preserved for routing, only display name is truncated.'
---
