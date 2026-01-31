---
title: 'Pattern: steering behavior vs force-based wandering'
status: closed
kind: spec
priority: 2
created-at: 2026-01-31T23:26:27.950672+01:00
closed-at: 2026-01-31T23:26:27.950678+01:00
close-reason: 'For smooth character movement without u-turns: use heading-based steering instead of force-based physics. Track a heading angle that changes gradually (limited turn rate, e.g., 45°/sec). Pick a new target heading periodically (every 2-3 sec) with moderate random deviation. Apply corrections (toward home, away from obstacles) as steering adjustments to the target, not instant force vectors. Result: characters walk in smooth arcs instead of jittering back and forth. See WorkerRenderer.ts simulate().'
---
