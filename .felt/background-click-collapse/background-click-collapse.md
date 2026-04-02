---
title: 'Background click: collapse animation'
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered
created-at: 2026-02-22T07:13:56.257349+01:00
outcome: 'Background click was snapping nodes to fog instantly (no animation). Root cause: visibleNodes was cleared before updateTierVisibility, making becomingFog always empty so collapseNodesRadial never fired. Fix: preserve visibleNodes so becomingFog is populated; pass dummy center {0,0} to trigger collapse animation; add skipVisibilityUpdate=true param to hideDetail to prevent second updateTierVisibility call from interrupting in-flight animation. Also fixed: tooltip not cleared on click — added clearTimeout(hoverTimer) and tooltip.hide in drag.end click path.'
---

(background-click-collapse)=
# Background click: collapse animation
