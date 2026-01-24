---
title: 'Bug: Session cityId mismatch in frontend state'
status: closed
kind: task
priority: 2
depends-on:
    - file-annotations-in-e8dbee22
created-at: 2026-01-24T00:29:23.748271+01:00
closed-at: 2026-01-24T00:29:23.748272+01:00
close-reason: |-
    **Confirmed bug in worker picker:**

    Console logs showed:
    - City found for path (hexarchy-v2)
    - 3 sessions exist in frontend state
    - 0 sessions match filter `s.cityId === city.id`

    **Key evidence:**
    - Server buildState() logs show sessions with correct cityIds matching hexarchy-v2 city
    - Frontend onGetWorkers receives city with DIFFERENT id than session cityIds
    - This happens even after full page refresh

    **Suspected cause:** City ID regeneration somewhere in the data flow. Cities loaded from persistence have stable IDs, but something is creating new city objects with randomUUID() that don't match the persisted session assignments.

    **Next steps:**
    1. Add server logging to compare city IDs at buildState vs what's in sessions
    2. Check if rebuildCities() creates new IDs instead of preserving them
    3. Trace where session.cityId gets assigned vs where city.id comes from

    **Debug code left in place:**
    - main.ts: console.log in onGetWorkers showing city.id and session cityIds
    - index.ts: console.log in buildState showing hexarchy-v2 city id and session cityIds
---
