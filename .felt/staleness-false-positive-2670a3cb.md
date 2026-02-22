---
title: 'Staleness false-positive: evidence timestamps must stay in sync'
status: closed
tags:
    - portolan
    - decision
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T06:43:56.396525+01:00
closed-at: 2026-02-22T07:01:08.180962+01:00
outcome: 'Section nodes (tapestry:bayeux, tapestry:portolan-nav, etc.) each have separate evidence.json files in results/claims/. Staleness is computed by comparing evidence mtimes between a node and its direct upstream dependencies. When timestamps drift — e.g., bayeux at midnight vs portolan-nav at 5am — the tapestry shows false staleness. The Tapestry (bayeux) appeared stale because Click Me (portolan-nav) had newer evidence. Fix: keep all evidence.json timestamps synchronized. For the portolan self-tapestry, they should always be updated together after structural changes. Commit: 0ccf164.'
---
