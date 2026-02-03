---
title: City panel X button unclickable
status: closed
kind: task
priority: 2
created-at: 2026-02-03T04:26:33.489316+01:00
closed-at: 2026-02-03T05:37:21.883657+01:00
close-reason: 'Fixed: Added z-index: 10 to #city-panel .close-btn and #worker-panel .close-btn. Button was getting covered by content with implicit stacking context.'
---

X close button on city panel doesn't respond to clicks. Discovered during Chrome testing of hook-based conversation capture.
