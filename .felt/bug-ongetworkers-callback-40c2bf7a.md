---
title: 'Bug: onGetWorkers callback returns empty - session/city matching fails'
status: closed
kind: task
priority: 2
created-at: 2026-01-23T23:55:08.810809+01:00
closed-at: 2026-01-23T23:55:08.810811+01:00
close-reason: |-
    Worker picker in FileViewerModal shows 'No workers in this city' even when workers exist on the map.

    **Location:** main.ts:83-96

    **The callback logic:**
    1. Finds city by: c.originId === originId && path.startsWith(c.path)
    2. Filters sessions by: s.cityId === city.id && s.originId === originId

    **Suspected issues:**
    - Session cityId might not match city.id
    - originId from CityPanel (this.currentCity.originId) might differ from session originId
    - The cities/sessions arrays might be stale when callback executes

    **To debug:** Add console.log in callback showing originId, path, matched city, and filtered sessions.
---
