---
title: Dynamic banner sizing based on text dimensions
status: closed
kind: decision
priority: 2
depends-on:
    - banner-scale-too-large-labels-dc02db79
created-at: 2026-01-18T19:58:00.160298+01:00
closed-at: 2026-01-18T22:06:01.631626+01:00
close-reason: Banner sprite scale now calculated from actual canvas dimensions. createLabel() returns {texture, width, height}. Sprite scale uses aspectRatio = width/height with fixed worldHeight (1.2 for cities, 0.8 for workers). Width varies with text length, padding controlled by hPadding/vPadding as multiples of fontSize. No more fixed sprite scales that ignore content.
---
