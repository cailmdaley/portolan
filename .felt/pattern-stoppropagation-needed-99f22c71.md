---
title: 'Pattern: stopPropagation needed when click handlers trigger re-renders'
status: closed
kind: spec
priority: 2
depends-on:
    - pattern-event-handler-d26b6bae
created-at: 2026-01-31T03:41:06.700767+01:00
closed-at: 2026-01-31T03:41:06.700777+01:00
close-reason: 'When a click handler triggers DOM re-render, the original target element is removed from DOM before event bubbles up. Document-level handlers that check `!panel.contains(target)` will fail because target is orphaned. Fix: call `e.stopPropagation()` in any click handler that re-renders its container. Encountered in WorkerActivityPanel thinking block expand/collapse.'
---
