---
title: Meeting bridge provenance recovery and HUD log access
status: closed
tags:
    - portolan
    - meeting
    - transcription
depends-on:
    - constitution-portolan-meeting
    - meeting-worker-transcript-bridge
created-at: 2026-04-02T20:26:08.791093+02:00
closed-at: 2026-04-02T20:29:33.992141+02:00
outcome: 'Meeting runs now remain discoverable after a Portolan server restart: MeetingBridge persists latest-meeting.json, recovers the newest recorded run at startup, and normalizes orphaned "running" state to stopped when no live source is attached. The city HUD meeting card now opens transcript.jsonl, injections.jsonl, and meeting.json directly in the existing file viewer, so raw provenance stays navigable inside Portolan instead of being stranded under ~/.portolan/meetings. Evidence: cd server && npm test; cd server && npm run build; npm run build.'
---

(meeting-bridge-provenance)=
Recover the last meeting run from ~/.portolan/meetings metadata on server startup and expose direct HUD links into transcript/injection/metadata files so raw provenance remains discoverable through Portolan's existing file viewer surface.
