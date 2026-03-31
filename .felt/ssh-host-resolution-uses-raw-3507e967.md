---
title: SSH host resolution uses raw hostname
status: closed
tags:
    - gotcha
depends-on:
    - stable-city-ids-e109b891
    - stale-controlmaster-breaks-ab430b0f
created-at: 2026-03-27T10:17:19.429491+01:00
outcome: 'getSshHost fallback chain returned raw hostname (e.g. c02) instead of SSH config name (candide) when CityManager/CityPersistence IDs diverged. Root cause: CityManager normalizes keys via baseSshHost (remote-candide:path) but CityPersistence used raw originId (remote-c02:path), producing different stableCityIds. getCityById lookup failed silently, falling through to originId.replace(''remote-'','''') = c02. Three fixes: (1) normalize persisted originId on load (remote-c02 → remote-candide), (2) fix pinnedCityIds.add(id) bug using wrong ID that could GC pinned cities, (3) path-based sshHost fallback in getSshHost.'
---
