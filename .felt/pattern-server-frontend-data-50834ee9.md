---
title: 'Pattern: Server→frontend data flow debugging with console.log injection'
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T00:16:38.471178+01:00
closed-at: 2026-01-24T00:16:38.471178+01:00
close-reason: |-
    For debugging state mismatch bugs across server/frontend boundary:

    **Technique:**
    1. Add server-side logging in buildState() to see what's being sent:
       `console.log('[buildState] session cityIds:', sessions.map(s => ({ name: s.name, cityId: s.cityId })))`

    2. Add frontend logging in callbacks to see what's received:
       `console.log('[onGetWorkers] city.id:', city.id, 'session cityIds:', JSON.stringify(sessions.map(s => s.cityId)))`

    3. Compare the two - mismatches reveal stale state or transformation bugs

    **Key insight:** JSON.stringify() arrays in console.log to see actual values instead of 'Array(4)'.

    **This session:** Revealed browser city.id didn't match server session.cityId despite same path.
---
