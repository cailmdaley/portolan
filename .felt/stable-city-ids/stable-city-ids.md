---
title: Stable city IDs
tags:
    - portolan
depends-on:
    - city-persistence-survive-beyond
created-at: 2026-03-23T10:00:34.767629+01:00
outcome: City IDs were randomUUID(), breaking bookmarked URLs across server restarts. Now deterministic SHA-256 hash of the city key (originId:resolvedPath), truncated to 32 hex chars. Both CityManager and CityPersistence use stableCityId(). Persisted cities auto-migrate old random UUIDs on load.
---

(stable-city-ids)=
# Stable city IDs
