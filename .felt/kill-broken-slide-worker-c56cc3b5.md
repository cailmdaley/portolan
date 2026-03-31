---
title: Kill broken slide worker
status: closed
created-at: 2026-03-15T17:59:15.04362+01:00
closed-at: 2026-03-15T18:00:04.780537+01:00
outcome: 'Removed the broken pure_eb worker named slide` on candide by targeting its tmux session ID ($59) instead of its shell-hostile name. The live websocket state briefly showed the stale 4-worker set during propagation, then stabilized at the expected pure_eb workers: moriond, paper, and papier.'
---
