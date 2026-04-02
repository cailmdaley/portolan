---
title: D3 forceCollide radius must match actual node scale
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered
created-at: 2026-02-22T01:56:35.431348+01:00
closed-at: 2026-02-22T07:01:08.211558+01:00
outcome: 'Fixed tapestry node overlap: forceCollide had a fixed radius of 65 for all nodes, but section nodes have scale=1.5 (rx=78) and non-section nodes have scale=1.25 (rx=65). Changed to per-node function: NODE_RX * scale + 8. Without this, section nodes overlap interior nodes during simulation.'
---

(d3-forcecollide-radius-must)=
# D3 forceCollide radius must match actual node scale
