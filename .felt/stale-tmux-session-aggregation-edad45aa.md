---
title: Stale tmux session aggregation causes message bleed
status: closed
kind: decision
priority: 2
created-at: 2026-02-06T00:18:40.111307+01:00
closed-at: 2026-02-06T00:18:40.111311+01:00
close-reason: getMessagesByTmux was aggregating ALL cached sessions with matching tmux name, including ancient ones from reused tmux names. Fixed by adding 1-hour cutoff — only aggregate sessions updated recently. Preserves Claude restart aggregation while preventing old dead sessions from bleeding into new workers.
---
