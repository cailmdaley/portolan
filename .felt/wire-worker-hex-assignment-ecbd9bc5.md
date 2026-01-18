---
title: Wire worker hex assignment & cleanup
status: closed
kind: task
tags:
    - ralph:2
priority: 2
depends-on:
    - server-14a1cdf1
created-at: 2026-01-18T00:34:20.910038+01:00
closed-at: 2026-01-18T00:36:48.749127+01:00
close-reason: Wired worker hex assignment in session lifecycle. Added workerHex field to Session interface. Sessions now receive hex positions clustered around their city when assigned. Worker hexes are released when sessions move cities or disconnect. Coordinates are relative to city center - frontend will add city position when rendering.
---
