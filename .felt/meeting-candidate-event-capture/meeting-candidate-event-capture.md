---
title: Meeting candidate event capture
status: closed
tags:
    - portolan
    - meeting
    - transcription
    - astra
depends-on:
    - constitution-portolan-meeting
    - meeting-live-operator
    - meeting-http-transcript-ingress
created-at: 2026-04-02T20:52:26.91381+02:00
outcome: 'Portolan meeting runs now have an explicit candidate-event lane between raw transcript/update logs and later felt formalization. MeetingBridge persists candidate-events.jsonl with transcript/operator provenance, injects accepted captures back into the active worker thread, exposes POST /meeting-bridge/candidate, and the HUD meeting card lets the operator capture candidate notes/questions/decisions/action items plus open the candidate event log. This preserves a human-gated promotion step without inventing a parallel scientific schema. Evidence: cd server && npx vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts src/__tests__/BrowserStateCoordinator.test.ts; cd server && npm run build; npm run build.'
---

(meeting-candidate-event-capture)=
Add an explicit meeting-native promotion lane for accepted notes, questions, decisions, and action items. Candidate events should stay inspectable on the active meeting run, remain linked to transcript provenance, and be human-gated before later fiber/ASTRA formalization.
