---
title: 'Edge fog bug: OR condition in revealNodesRadial cleared opacity for fog-endpoint edges'
status: closed
depends-on:
    - pyramid-tapestry-tiered
created-at: 2026-02-22T06:12:42.826342+01:00
closed-at: 2026-02-22T07:01:08.072956+01:00
outcome: 'revealNodesRadial used OR condition — if EITHER endpoint was newly visible, the edge''s inline opacity was cleared (style.opacity = ''''). This allowed edges leading to still-fogged 2-hop neighbors to become visible. Fix: add AND check against this.visibleNodes (already updated to final visible set before revealNodesRadial is called). Edges only get opacity cleared when BOTH endpoints are in the final visible set. Commit: 2b0ccb2.'
---

(edge-fog-bug-or-condition-in)=
# Edge fog bug: OR condition in revealNodesRadial cleared opacity for fog-endpoint edges
