---
title: Background formalization workflow
tags:
    - felt
    - pattern
depends-on:
    - formalization-tiers
created-at: 2026-04-01T22:33:20.075952+02:00
outcome: Agents can formalize fibers while computations run in background. Launch computation → write inputs/expected outputs → computation finishes → add insights/outcome. This makes formalization compatible with async work instead of forcing retrospective cleanup. Claude Code supports this via run_in_background for Bash commands.
---

(background-formalization)=
# Background formalization workflow
