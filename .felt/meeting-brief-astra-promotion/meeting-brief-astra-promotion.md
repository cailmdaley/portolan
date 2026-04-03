---
title: Meeting brief ASTRA promotion
status: closed
tags:
    - meeting
    - astra
    - mystra
depends-on:
    - constitution-portolan-meeting
    - meeting-live-brief-surface
created-at: 2026-04-03T03:08:54.873914+02:00
closed-at: 2026-04-03T03:08:59.445991+02:00
outcome: 'MeetingBridge now promotes accepted live briefs into astra.yaml as stable ASTRA sub-analyses in addition to creating the felt brief fiber. Each promoted brief records meeting provenance, transcript/update/evidence log inputs, accepted-note findings, and accepted decisions, so MySTRA has a renderable document node instead of a HUD-only summary. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts; npm --prefix server run build; npm run build.'
---

(meeting-brief-astra-promotion)=
Promote accepted Portolan meeting briefs into astra.yaml as renderable ASTRA sub-analyses instead of stopping at felt-only brief fibers. The promoted brief should preserve meeting provenance, carry accepted decisions/notes into the existing ASTRA structures MySTRA already renders, and remain conservative about tentative material by only syncing human-promoted brief state.
