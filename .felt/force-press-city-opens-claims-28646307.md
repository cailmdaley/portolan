---
title: Force-press city opens claims dashboard or playground
status: closed
kind: decision
priority: 2
depends-on:
    - claims-annotation-inline-bba0fc30
created-at: 2026-02-07T21:11:26.494342+01:00
closed-at: 2026-02-07T21:11:26.494347+01:00
close-reason: 'Force-press (webkitmouseforcedown) on a city now opens deep content: hasClaims → claims dashboard, else hasPlaygrounds → playground viewer. Falls through to context menu for cities with neither, or for non-city targets (workers, empty hexes). Implemented by hit-testing for city in the forcedown handler before calling handleContextMenu.'
---
