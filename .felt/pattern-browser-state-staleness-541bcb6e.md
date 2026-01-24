---
title: 'Pattern: Browser state staleness after server restart causes ID mismatch'
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T00:16:27.38551+01:00
closed-at: 2026-01-24T00:16:27.385512+01:00
close-reason: |-
    When debugging 'No workers in this city' bug in worker picker:

    **Symptom:** onGetWorkers callback finds city but returns 0 workers despite sessions existing.

    **Investigation:**
    - Server logs showed sessions with cityId 'd8eb2db3-...' (correct hexarchy-v2)
    - Browser console showed city.id as '5cbb2e9d-...' (different!)
    - Same path, different IDs

    **Root cause:** Browser had stale state from before server restart. City IDs are generated with randomUUID() and change on server restart. Browser cached old city IDs while sessions got new ones.

    **Fix:** Full browser refresh syncs state. Not a code bug - operational issue during development.

    **Lesson:** When debugging state mismatches, check if browser has fresh data. Server restarts regenerate IDs.
---
