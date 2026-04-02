---
title: Meeting candidate provenance selection and validation
status: closed
created-at: 2026-04-02T21:02:18.384867+02:00
closed-at: 2026-04-02T21:08:28.892469+02:00
outcome: 'Meeting candidate capture now requires explicit cited provenance instead of silently defaulting to the latest chunk/update. The HUD lets operators title a candidate event, select transcript chunks and operator updates directly from the live thread, and clear or inspect the current citation set before capture. The server now rejects candidate events with missing or impossible provenance indices, preserving the invariant that accepted meeting structure remains traceable back to transcript/operator evidence. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts; npm --prefix server run build; npm run build. Commit: 70bc3b4.'
---

(meeting-candidate-provenance)=
# Meeting candidate provenance selection and validation
