---
title: Tapestry force simulation + flutter animation iteration 3 handoff
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered
created-at: 2026-02-21T22:07:59.184679+01:00
closed-at: 2026-02-21T23:00:57.697741+01:00
outcome: 'Session accomplished: (1) Fixed flutter compilation errors — flutterTick type was (t:number)=>void but closure uses this.flutterT directly; corrected to ()=>void. stopFlutter() wired into hide(). (2) Replaced flutter with per-edge spring-damper physics (subagent): EdgeDatum gains sagPos/sagVel/sagInitialized; initial random kick gives ring-in effect; k=4.0, c=0.5 (ζ≈0.12, ~longer ringing); node-avoidance heuristic repels control points from non-connected nearby nodes; thermal noise floor keeps edges alive. (3) Elastic drag: draggingNodes Set in renderDAG scope; spring integration freezes while endpoint held, resumes on release — edge stretches then rings back to new equilibrium. (4) Node visuals: random ink palette by ID hash (verdigris #2E5252 / iron-gall #6B3838 / slate #8C9090); fills at [0.55, 0.18] inner/outer; knockout moved to separate SVG layer (tapestry-knockouts) between edges and nodes so it stays opaque regardless of node highlighting opacity; knockout color matches canvas (#E8DDD0). (5) Canvas background: .tapestry-dag set to #E8DDD0 (warm parchment). (6) Upstream dots above node, downstream dots below, using splitNeighborFibers(). (7) Font scaling: fitSize() scales down when text would overflow rx*1.7; base 14px nodes, 16px sections. (8) Damping reduced c=1.2→0.5 for looser ringing.'
---

(tapestry-force-simulation)=
# Tapestry force simulation + flutter animation iteration 3 handoff
