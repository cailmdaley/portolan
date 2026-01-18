---
title: Implement orphaned city cleanup
status: closed
kind: task
tags:
    - ralph:2
priority: 2
depends-on:
    - server-14a1cdf1
created-at: 2026-01-18T00:34:22.461819+01:00
closed-at: 2026-01-18T00:35:52.846637+01:00
close-reason: Implemented automatic removal of orphaned cities. Added 5-second grace period after startup to prevent premature cleanup during session loading. In the onSessionsChange callback, after assigning cityIds to all sessions, the code now builds a set of active city IDs and removes any cities that have no sessions pointing to them. Uses CityManager.removeCity() which properly cleans up worker hex assignments. All cities are treated as ephemeral per spec. Build verified with npm run build.
---
