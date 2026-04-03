---
title: VoiceInk live partial streaming
status: closed
tags:
    - question
    - portolan
    - meeting
    - voiceink
depends-on:
    - constitution-portolan-meeting
    - investigate-voiceink-transcript
created-at: 2026-04-02T19:47:29.220753+02:00
closed-at: 2026-04-03T02:30:26.04458+02:00
outcome: 'Portolan now has a generic live partial transcript ingress path without waiting on VoiceInk internals: MeetingBridge keeps a stable chunk index across repeated source chunk revisions, persists every revision in transcript.jsonl with partial/revision flags, only advances the live HUD thread to the latest revision, and exposes batch uploads over POST /meeting-bridge/chunks for alternate capture tools. The HUD labels tentative revised chunks explicitly, so live narration and correction can run against partial transcript evidence without silently hardening it into settled text. Evidence: cd server && npx vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts src/__tests__/BrowserStateCoordinator.test.ts; cd server && npm run build; npm run build.'
---

(voiceink-live-partial-streaming)=
Decide whether Portolan should keep the completed-row VoiceInk bridge for the near term or modify/supplement VoiceInk with a true partial-transcript stream. The current runtime proves chunked-complete ingestion into tmux workers; what remains open is the best next ingress path for lower-latency live narration and corrections without sacrificing a simple replaceable boundary.
