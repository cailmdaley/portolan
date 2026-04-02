---
title: Meeting websocket state
status: closed
tags:
    - portolan
    - meeting
    - transcription
depends-on:
    - constitution-portolan-meeting
    - hud-meeting-bridge-surface
    - meeting-live-operator
created-at: 2026-04-02T20:45:13.551099+02:00
outcome: 'Meeting bridge state now rides Portolan''s primary websocket state loop instead of a HUD-only polling side channel. MeetingBridge emits state-change notifications, BrowserStateCoordinator includes meetingBridge in every state snapshot, server index rebroadcasts on live meeting transitions, and the frontend HUD consumes shared meeting state from FrontendStateSync rather than polling /meeting-bridge every 3 seconds. This keeps the meeting assistant inside Portolan''s existing broadcast model and makes operator updates/chunk counters land in the same live state flow as cities, workers, and activity. Evidence: cd server && npm test; cd server && npm run build; npm run build.'
---

(meeting-websocket-state)=
The first HUD meeting surface worked, but it pulled runtime state through a dedicated HTTP poller. That made meeting state a bolt-on UI side channel rather than part of Portolan's native broadcast loop.

This iteration moved meeting bridge state into the same websocket snapshots that already carry cities, sessions, origins, and activity. The bridge now exposes a state-change subscription, BrowserStateCoordinator can attach the current meeting snapshot to every broadcast, and the server rebroadcasts immediately when meeting start/stop/chunk/update events mutate the run.

On the frontend, FrontendStateSync now stores meetingBridge alongside the rest of the synchronized world state, and CityHUDHeader renders from that shared snapshot. The polling timer and GET refresh path are no longer needed for the HUD to stay current.
