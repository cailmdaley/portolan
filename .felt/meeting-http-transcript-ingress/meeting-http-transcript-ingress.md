---
title: Meeting HTTP transcript ingress
status: closed
tags:
    - portolan
    - meeting
    - transcription
depends-on:
    - constitution-portolan-meeting
    - meeting-worker-transcript-bridge
created-at: 2026-04-02T20:32:59.736722+02:00
outcome: 'Portolan meeting runs now expose a generic local transcript ingress in addition to the VoiceInk poller. MeetingBridge accepts sourceType=manual, keeps the same tmux-worker/provenance path for non-VoiceInk meetings, and POST /meeting-bridge/chunk appends transcript chunks into the active run so alternate capture tools can plug in without duplicating worker delivery. Evidence: focused MeetingBridge and HttpApi meeting tests passed; server build passed; root build passed.'
---

(meeting-http-transcript-ingress)=
Portolan's first meeting bridge tailed VoiceInk directly, but alternate capture tools still had no stable way to feed the active worker session without reimplementing tmux delivery. Add a source-agnostic local ingress path that reuses the same meeting run, provenance logging, and worker injection flow.
