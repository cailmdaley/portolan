---
title: Fix tooltip flicker on bird hover
status: closed
tags:
    - portolan
created-at: 2026-03-13T13:06:07.266434+01:00
closed-at: 2026-03-13T13:06:11.028097+01:00
outcome: 'Bird flock hit detection has gaps between sprites (0.8 radius per bird). Mouse moving between birds triggered clearHover→scheduleHide→targetWorkerId=null, so re-entering the same worker started a fresh 300ms show delay. Fix: (1) clearHover(force=false) no longer nulls targetWorkerId — scheduleHide handles cleanup, (2) updateHover cancels hide timer when re-entering same worker, (3) hide grace period raised from 120ms→250ms. File: ZoneRendererWorkerTooltip.ts.'
---
