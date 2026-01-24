---
title: Handoff sessions should be named by fiber ID for uniqueness
status: closed
kind: decision
priority: 2
created-at: 2026-01-22T16:23:52.715259+01:00
closed-at: 2026-01-22T16:24:01.73378+01:00
close-reason: |-
    Originally handoff used generic name: handoff-{last8chars}. This meant only one handoff session could exist.

    Changed to use full fiber ID as tmux session name. Each fiber gets its own session. Can handoff to multiple fibers simultaneously.

    Tab titles:
    - Local: fiberId (e.g., fog-of-war-reveal-terrain-near-5d2d49ec)
    - Remote: fiberId@host (e.g., investigate-namaster-linear-vs-1cc81db4@candide)
---
