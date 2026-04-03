---
title: Meeting live document surface
status: closed
tags:
    - meeting
    - astra
    - mystra
depends-on:
    - constitution-portolan-meeting
    - meeting-live-brief-surface
    - meeting-brief-astra-promotion
created-at: 2026-04-03T03:10:33.965695+02:00
closed-at: 2026-04-03T03:13:00.468217+02:00
outcome: 'Portolan meetings now materialize a continuously updated live-brief.md beside meeting.json, making the active meeting brief a renderable document object rather than only HUD state. MeetingBridge regenerates that document on every persisted state change, recovers its path for older runs with a backward-compatible default, and exposes it over websocket state; the HUD adds a direct Open live document control. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts; npm --prefix server run build; npm run build.'
---

(meeting-live-document-surface)=
Continuously materialize the active meeting brief as a renderable document object under the meeting run itself, so Portolan can open and inspect a live narrative/doc artifact before explicit promotion. The bridge should update this artifact whenever transcript, operator, candidate, assistant, or retrieval state changes, and the HUD should treat it as the primary meeting record rather than only exposing raw logs and controls.
