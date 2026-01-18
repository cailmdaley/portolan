---
title: 'Camera: PerspectiveCamera at 45° angle, distance-based zoom'
status: closed
kind: decision
tags:
    - '[hexarchy-v2]'
priority: 2
depends-on:
    - visual-polish-wishlist-v1-f0a906d8
created-at: 2026-01-18T02:53:44.213525+01:00
closed-at: 2026-01-18T02:53:52.219434+01:00
close-reason: 'Switched from OrthographicCamera (top-down) to PerspectiveCamera for Civ-like feel. Settings: 50° FOV, 45° angle from horizontal, 45° rotation around Y (diagonal view), distance=15 default. Pan uses camera''s screen-aligned axes (right/forward vectors projected to XZ plane) for intuitive drag behavior. screenToWorld uses ray-plane intersection at Y=0.'
---
