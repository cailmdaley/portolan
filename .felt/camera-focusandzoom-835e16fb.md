---
title: 'Camera focusAndZoom: screenOffsetY=0.95 for bottom positioning'
status: closed
kind: decision
priority: 2
created-at: 2026-02-07T00:48:07.579912+01:00
closed-at: 2026-02-07T00:48:07.579916+01:00
close-reason: City click, worker cycling, and initial focus all use focusAndZoom(pos, 6, 0.95) to place the target at the bottom 5% of screen. Leaves map context visible above. The screenOffsetY parameter already existed in Camera.ts — just needed passing through.
---
