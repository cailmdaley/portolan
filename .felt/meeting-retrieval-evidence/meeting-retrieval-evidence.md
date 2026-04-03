---
title: Meeting retrieval evidence capture
status: closed
tags:
    - portolan
    - meeting
    - retrieval
depends-on:
    - constitution-portolan-meeting
    - meeting-retrieval-surface
created-at: 2026-04-03T02:38:14.555108+02:00
closed-at: 2026-04-03T02:43:46.364987+02:00
outcome: 'Portolan meetings now persist a retrieved-evidence lane alongside retrieval requests. Opening a retrieval result from the HUD POSTs /meeting-bridge/retrieval/evidence, MeetingBridge records retrieved-evidence.jsonl with optional retrieval-request provenance, injects the opened fiber/file back into the active worker thread, and exposes the lane in websocket state plus the live HUD thread. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts src/__tests__/BrowserStateCoordinator.test.ts; npm --prefix server run build; npm run build.'
---

(meeting-retrieval-evidence)=
Capture which local fibers and files were actually opened from meeting retrieval results so the live meeting record preserves pulled evidence, not just retrieval requests.
