---
title: Meeting retrieval surface
status: closed
tags:
    - meeting
    - retrieval
    - portolan
depends-on:
    - constitution-portolan-meeting
    - meeting-live-narrative-surface
created-at: 2026-04-02T21:10:21.069997+02:00
closed-at: 2026-04-02T21:18:33.373354+02:00
outcome: 'Portolan meetings now have a first-class retrieval lane instead of burying evidence requests inside generic operator text. MeetingBridge persists retrieval-requests.jsonl, injects structured retrieval requests into the active worker thread, recovers the lane across restarts, and exposes it through websocket state plus POST /meeting-bridge/retrieval. The HUD meeting card now lets an operator search local fibers and workspace files in place, open matching evidence directly, submit the same query to the live assistant, and inspect recent retrieval requests alongside transcript, corrections, and candidate captures. Evidence: cd server && npx vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts; cd server && npm run build; npm run build.'
---

(meeting-retrieval-surface)=
Make retrieval first-class in the live Portolan meeting surface. Add a meeting-native query lane that can search existing fibers and workspace files, open the relevant evidence in place, and optionally inject a structured retrieval request into the active worker thread without collapsing the meeting UI into a generic chat client.
