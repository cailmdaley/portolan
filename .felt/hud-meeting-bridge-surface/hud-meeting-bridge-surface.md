---
title: HUD meeting bridge surface
status: closed
tags:
    - portolan
    - meeting
    - transcription
depends-on:
    - constitution-portolan-meeting
    - meeting-worker-transcript-bridge
created-at: 2026-04-02T20:24:19.216158+02:00
outcome: 'Portolan''s existing city HUD now exposes the first coherent meeting-assistant control surface: users can start or stop the VoiceInk transcript bridge on a chosen worker, see live bridge status for the current city, and inspect chunk/error state without leaving the existing worker-centric UI. Evidence: npm run build; cd server && npm test.'
---

(hud-meeting-bridge-surface)=
Built the first frontend meeting surface around the existing /meeting-bridge server API instead of inventing a separate chat pane. The city HUD header now includes a meeting block that polls bridge state, offers start controls per worker in the current city, shows running/stopped/error status, and surfaces chunk counts plus last chunk preview. This keeps meeting ingress inside Portolan's existing city/worker affordance and makes the transcript-to-worker bridge operable from the app.
