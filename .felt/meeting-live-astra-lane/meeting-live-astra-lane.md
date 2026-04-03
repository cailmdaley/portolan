---
title: Meeting live ASTRA lane
status: closed
tags:
    - meeting
    - astra
    - mystra
depends-on:
    - constitution-portolan-meeting
    - meeting-live-document-surface
created-at: 2026-04-03T03:14:18.776313+02:00
closed-at: 2026-04-03T03:18:27.650857+02:00
outcome: 'MeetingBridge now continuously syncs the active live brief into astra.yaml as a dedicated meeting-live analysis lane, distinct from explicit meeting-brief promotion. The sync reuses the existing live brief state, writes provenance-rich ASTRA inputs/findings/decisions on every persisted meeting update, recovers the live ASTRA path/id through meeting state, and exposes that lane in the HUD with a direct open control. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts src/__tests__/BrowserStateCoordinator.test.ts; npm --prefix server run build; npm run build.'
---

(meeting-live-astra-lane)=
Continuously sync the active Portolan meeting brief into astra.yaml as a live analysis lane so MySTRA can render the current meeting state without waiting for explicit promotion. Keep the lane reversible and clearly distinct from accepted brief promotion and accepted decision promotion.
