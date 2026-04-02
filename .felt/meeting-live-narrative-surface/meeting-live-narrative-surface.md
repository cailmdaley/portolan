---
title: Meeting live narrative surface
status: closed
tags:
    - portolan
    - meeting
    - transcription
    - astra
depends-on:
    - constitution-portolan-meeting
    - meeting-websocket-state
    - meeting-candidate-event-capture
created-at: 2026-04-02T20:55:41.247464+02:00
closed-at: 2026-04-02T21:00:41.289684+02:00
outcome: 'Portolan''s meeting bridge state now carries a bounded live narrative thread instead of only counters and file paths. MeetingBridge persists the most recent transcript chunks, operator updates, and candidate events in meeting metadata, recovers them on restart with backward-compatible defaults for older runs, and exposes the same recent provenance over the shared websocket state. The city HUD meeting card now renders that live thread directly with lane labels and cited chunk/update indices while keeping the raw logs one click away. Evidence: cd server && npx vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/BrowserStateCoordinator.test.ts; cd server && npm run build; npm run build.'
---

(meeting-live-narrative-surface)=
Expose a rolling live meeting thread in Portolan itself instead of reducing active runs to counters and file links. The meeting websocket state should carry recent transcript chunks, operator updates, and candidate events so the HUD can show the live narrative with provenance while preserving the existing raw logs.
