---
title: felt on now works on closed fibers (--reopen flag removed)
status: closed
kind: decision
priority: 2
created-at: 2026-01-22T16:24:38.662294+01:00
closed-at: 2026-01-22T16:24:45.962201+01:00
close-reason: |-
    Previously felt on <id> refused to activate closed fibers, requiring --reopen flag. This caused friction with handoff — clicking handoff on a closed fiber would fail.

    User updated felt to be more permissive: felt on now works on closed fibers, reopening them automatically. The --reopen flag is gone.

    Implication: handoff commands don't need --reopen, simpler command construction.
---
