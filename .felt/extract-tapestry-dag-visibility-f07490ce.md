---
title: Extract Tapestry DAG visibility controller
status: closed
tags:
    - portolan
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-11T22:04:22.780268+01:00
outcome: Extracted node visibility, section expansion, radial reveal/collapse animation, and selection highlighting from TapestryDagGraph into TapestryDagVisibility so the graph now focuses on SVG/runtime orchestration and event wiring. TapestryDagGraph dropped to 373 LOC, TapestryDagVisibility owns 405 LOC, and verification passed with npm run build plus cd server && npm test.
---
