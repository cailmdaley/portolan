---
title: BFS descendant search for CLI detection in deep process trees
status: closed
tags:
    - portolan
depends-on:
    - gotcha-codex-process-name-is-09e0e1b9
created-at: 2026-02-20T21:02:44.924773+01:00
outcome: 'Ralph launches codex via a python script, creating bash→python3→MainThread→codex (3+ levels deep). The original pgrep -P one-level child check missed it. Fix: BFS through descendants up to depth 4 in both agent.js and SessionTracker.ts. Both files now walk a frontier of PIDs, checking comm and args at each level. Note in agent.js, detection is purely local (runs on remote), so the BFS is cheap.'
---
