---
title: D3 forceCollide radius must match actual node scale
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T01:56:35.431348+01:00
outcome: 'Fixed tapestry node overlap: forceCollide had a fixed radius of 65 for all nodes, but section nodes have scale=1.5 (rx=78) and non-section nodes have scale=1.25 (rx=65). Changed to per-node function: NODE_RX * scale + 8. Without this, section nodes overlap interior nodes during simulation.'
---
