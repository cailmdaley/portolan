---
title: Context menu on label container
status: closed
kind: decision
priority: 2
created-at: 2026-02-01T13:19:04.415099+01:00
closed-at: 2026-02-01T13:19:04.415102+01:00
close-reason: Worker labels have pointer-events:auto for clicks, which captured right-click. Fixed by checking if target is inside .label-container in contextmenu handler, not just canvas.
---
