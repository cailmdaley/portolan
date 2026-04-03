---
title: Meeting manual ingress surface
status: closed
tags:
    - task
    - portolan
    - meeting
    - transcription
    - astra
depends-on:
    - constitution-portolan-meeting
    - meeting-http-transcript-ingress
    - hud-meeting-bridge-surface
created-at: 2026-04-03T02:57:59.012993+02:00
closed-at: 2026-04-03T03:00:43+02:00
outcome: 'Portolan''s meeting HUD now exposes the generic manual transcript ingress path instead of only the VoiceInk bridge. The meeting start controls let an operator start either a VoiceInk-backed run or a manual HTTP-ingress run on any worker, the running card labels the active source and explains how to feed manual chunks into POST /meeting-bridge/chunk or /meeting-bridge/chunks, and the duplicate live-brief rendering was removed so the card reads as one coherent stance surface. The server start endpoint now rejects invalid sourceType values, and focused meeting bridge tests cover manual start selection plus invalid source validation. Evidence: npm --prefix server exec vitest run src/__tests__/HttpApi.meeting.test.ts src/__tests__/MeetingBridge.test.ts; npm --prefix server run build; npm run build.'
---

(meeting-manual-ingress-surface)=
# Meeting manual ingress surface

Portolan already had the generic HTTP transcript ingress API and MeetingBridge already supported `sourceType: manual`, but the existing HUD only exposed the VoiceInk path. That kept alternate capture tools technically possible but operationally hidden behind raw API knowledge, which weakened the constitution's replaceable-ingress boundary.

This iteration made manual ingress a first-class meeting start mode in the existing city HUD rather than a separate setup path. Each worker now offers explicit `VoiceInk` and `Manual` start actions, the active meeting card labels the source in human terms, and manual runs show the exact chunk endpoints to target while they are active.

The same pass tightened the API contract by validating `sourceType` on `POST /meeting-bridge/start` and added focused HTTP tests for both manual-run startup and invalid source rejection. The duplicate rendering of the live brief inside the meeting card was also removed so the derived stance appears once, ahead of the raw thread, as intended.
