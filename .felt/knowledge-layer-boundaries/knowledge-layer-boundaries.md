---
title: Knowledge layer boundaries
status: closed
tags:
    - decision
    - doc
created-at: 2026-03-14T16:42:08.235914+01:00
outcome: 'Three layers with clear boundaries: (1) CLAUDE.md — lean lookup table. Commands, architecture, one-liner gotchas with fiber links. No paragraphs. (2) Memory — user context, feedback, remote host details, cross-session references. NOT project internals derivable from code. (3) Fibers — source of truth for decisions, bugs, patterns. CLAUDE.md and memory point here for depth. Cleaned up: trimmed 15 gotcha paragraphs to one-liners, moved tapestry interaction model/patterns/gotchas out of memory into fibers and CLAUDE.md where they belong.'
---

(knowledge-layer-boundaries)=
# Knowledge layer boundaries
