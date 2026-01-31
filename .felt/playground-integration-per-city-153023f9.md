---
title: 'Playground integration: per-city scoping via hexarchy proxy'
status: closed
kind: decision
priority: 2
depends-on:
    - pattern-hexarchy-remote-content-8180cf9d
created-at: 2026-01-31T01:49:00.748421+01:00
closed-at: 2026-01-31T01:49:00.748424+01:00
close-reason: 'Playgrounds are scoped per-city in .hexarchy/playgrounds/. Remote access works through hexarchy''s existing /playground and /playground-list endpoints, same pattern as claims-dashboard. Chose per-city over global because: simpler UI (button in CityPanel), natural project context, avoids new top-level UI. Global playgrounds can live in loom if needed.'
---
