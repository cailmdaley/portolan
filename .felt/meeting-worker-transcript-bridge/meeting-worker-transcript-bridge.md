---
title: Meeting worker transcript bridge
status: closed
tags:
    - portolan
    - meeting
    - transcription
    - astra
depends-on:
    - constitution-portolan-meeting
    - investigate-voiceink-transcript
created-at: 2026-04-02T19:47:29.212902+02:00
outcome: 'Portolan now has a working v1 transcript-to-worker ingress path: VoiceInk completed transcripts can be tailed by the server, logged with provenance, and injected into a chosen worker session using the existing Kitty/tmux model. Evidence: cd server && npm test && npm run build.'
---

(meeting-worker-transcript-bridge)=
Implemented a first server-side meeting bridge for Portolan. The bridge can start a VoiceInk-backed transcript source, persist raw transcript chunks plus injected prompts under ~/.portolan/meetings/<meeting-id>/, and feed wrapped transcript blocks directly into an existing local or remote tmux worker session. Transport is centralized through TmuxSessionMessenger so annotations, handoff, and meeting ingress share the same local/remote paste-buffer path. HTTP surface: GET /meeting-bridge, POST /meeting-bridge/start, POST /meeting-bridge/stop.
