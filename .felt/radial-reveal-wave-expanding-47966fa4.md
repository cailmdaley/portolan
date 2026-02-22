---
title: 'Radial reveal wave: expanding circle replaces edge-pulse animation'
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-21T23:21:07.456434+01:00
outcome: 'Replaced edge-pulse dot animation (gold dot traveling along SVG path to each newly-visible node) with an expanding radial circle. Ring (gold #9A7B35, thin 1.5px stroke) expands from clicked node''s simulation coordinates; fog nodes fade in (0→1, 280ms) as the ring radius passes them. Distance-based triggering naturally staggers nodes by position — no artificial delays. Ring fades as it passes the outermost node. Committed 1509b97. Center coordinates passed as {x, y} parameter from drag datum through updateTierVisibility() → revealNodesRadial().'
---
