---
title: Cities derived from sessions, not persisted
status: closed
kind: decision
priority: 2
created-at: 2026-01-18T03:16:33.051758+01:00
closed-at: 2026-01-18T03:16:33.051758+01:00
close-reason: 'Cities now exist only while ≥1 session has that cwd. No ~/.hexarchy/cities.json. CityManager.updateFromSessions(cwds) replaces addCity/removeCity — derive, don''t store. Hex positions stable during server lifetime but forgotten on restart. Simplifies model: sessions are the source of truth, cities are just a grouping.'
---
