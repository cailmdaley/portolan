---
title: Card viewport clamping breaks spatial pinning
status: closed
kind: decision
priority: 2
created-at: 2026-02-06T00:19:09.517499+01:00
closed-at: 2026-02-06T00:19:09.517503+01:00
close-reason: 'DO NOT add viewport clamping to applyTransform(). Cards must stay pinned to map coordinates (their swarm position). Clamping was added by ralph to keep headers visible but broke the spatial relationship — cards drifted in Y when panning. Transform must remain simple: translateY(-50%) scale(currentScale).'
---
