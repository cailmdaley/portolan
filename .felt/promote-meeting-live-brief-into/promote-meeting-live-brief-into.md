---
title: Promote meeting live brief into durable felt record
status: closed
tags:
    - portolan
    - meeting
    - felt
depends-on:
    - constitution-portolan-meeting
created-at: 2026-04-03T02:51:56.972855+02:00
closed-at: 2026-04-03T02:56:42.97302+02:00
outcome: 'Portolan meetings now have a durable promotion lane for the current live brief. MeetingBridge can snapshot the derived current stance into a real felt fiber with transcript/operator/candidate/retrieval provenance, persists brief-promotions.jsonl plus metadata counters for restart-safe discovery, exposes POST /meeting-bridge/brief/promote, and the HUD surfaces a one-click Promote brief action plus brief-promotion log visibility. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts; npm --prefix server run build; npm run build.'
---

(promote-meeting-live-brief-into)=
Add a meeting-native promotion lane that snapshots the current live brief into a real felt fiber with transcript/operator/retrieval provenance, surfaced from the Portolan HUD and persisted in meeting metadata.
