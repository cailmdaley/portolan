---
title: Meeting live brief surface
status: closed
tags:
    - portolan
    - meeting
    - astra
depends-on:
    - constitution-portolan-meeting
    - meeting-live-narrative-surface
    - meeting-live-operator
    - meeting-candidate-event-capture
    - meeting-retrieval-evidence
created-at: 2026-04-03T02:50:22.951446+02:00
outcome: 'MeetingBridge now carries a derived liveBrief that turns the meeting surface from a log viewer into a current-stance view. The HUD shows current narrative, accepted notes, open questions, decisions, action items, and evidence in view; operator updates now carry explicit intent labels; and persisted/recovered meeting metadata stays backward-compatible by deriving the brief when older runs lack it. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts; npm --prefix server run build; npm run build.'
---

(meeting-live-brief-surface)=
Portolan's meeting card already exposed the raw live thread, but the constitution asks for a stronger live account of where the meeting stands. This iteration adds a derived brief directly onto MeetingBridge state instead of inventing a second persisted schema: current operator narrative, accepted notes, open questions, decisions, action items, and evidence currently in view.

The brief is recomputed whenever operator updates, candidate events, retrieved evidence, or candidate promotions land, persisted in meeting metadata, and recovered on restart with backward-compatible derivation for older runs. On the HUD side, the meeting card now renders that brief ahead of the raw thread and lets operators classify steering updates as correction, narrative state, redirect, or open issue before injecting them back into the assistant thread.
