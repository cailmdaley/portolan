---
title: Force-directed layout
status: open
depends-on:
    - tapestry-rendering-0a402a96
created-at: 2026-02-21T17:18:36.073009+01:00
outcome: D3-force simulation with charge repulsion (-500), link distance (140px), collision detection (60px radius), and custom branch separation force. 800-tick burn-in computes stable positions, then X is pinned.
---

The tapestry layout is computed by a D3 force simulation running on all nodes. The forces: charge repulsion (nodes push each other apart), link attraction (connected nodes pull together), collision detection (no overlaps), and a custom branch-separation force that keeps independent branches from entangling. After 800 ticks of burn-in, the simulation has found stable positions.

Section nodes (tier:1) then have their horizontal position pinned — they become the column anchors. Interior nodes are snapped to their nearest section parent's column and released, letting link forces pull them into natural vertical clusters. When a section is expanded, newly revealed nodes join the simulation at low alpha (0.05) and settle without disturbing the rest.

The result is a layout that reads left to right by dependency depth but distributes nodes vertically by the forces of the graph structure. Dense regions compress; sparse ones breathe. The layout isn't computed for aesthetic reasons — it emerges from the actual dependency relationships, which means the visual shape of the tapestry reflects the shape of the work.
