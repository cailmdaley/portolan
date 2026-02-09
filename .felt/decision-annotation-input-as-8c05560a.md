---
title: 'Decision: annotation input as popover not inline'
status: closed
kind: decision
priority: 2
depends-on:
    - claims-annotation-side-panel-f290eeb2
created-at: 2026-02-07T21:11:39.848846+01:00
closed-at: 2026-02-07T21:11:39.84886+01:00
close-reason: Annotation textarea appears as a fixed-position popover floating above the highlight/pin, not inserted into document flow. Inline insertion (afterEl.after(bar)) pushed content down and cluttered the claim view. Popover uses getBoundingClientRect of the anchor (mark element or pin), positions above with caret arrow, flips below if insufficient room, clamps horizontally to viewport. z-index 99999 escapes iframe stacking context issues that were the original motivation for the refactor.
---
