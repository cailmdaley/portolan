---
title: 'Node reveal lag: opacity starts at 90% edge draw (NODE_LAG=0.90)'
status: closed
tags:
    - portolan
depends-on:
    - radial-reveal-wave-expanding-47966fa4
created-at: 2026-02-22T01:56:29.943055+01:00
closed-at: 2026-02-22T07:01:08.372521+01:00
outcome: 'In revealNodesRadial, node opacity was driven directly by incoming edge fraction, causing nodes to start appearing as soon as the edge began drawing. Fixed with NODE_LAG=0.90: node opacity starts from 0 only when the incoming edge is 90% drawn, then ramps to 1 over the final 10% via smoothstep. Node and edge complete simultaneously. Formula: nodeFraction = smoothstep((edgeFraction - 0.90) / 0.10).'
---
