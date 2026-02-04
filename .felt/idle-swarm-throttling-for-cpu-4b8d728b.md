---
title: Idle swarm throttling for CPU efficiency
status: closed
kind: decision
priority: 2
depends-on:
    - portolan-rendering-performance-a24aefa0
created-at: 2026-02-04T01:15:30.624431+01:00
closed-at: 2026-02-04T01:15:30.624434+01:00
close-reason: Swarm particles update every 3rd frame when idle (~20fps instead of 60fps). Saves ~66% CPU. Compensates deltaTime and time advancement so motion stays smooth. Active swarms stay at 60fps. Chrome renderer dropped from 30% to 11% CPU.
---
