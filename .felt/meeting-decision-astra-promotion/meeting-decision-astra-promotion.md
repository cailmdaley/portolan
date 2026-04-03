---
title: Meeting decision ASTRA promotion
status: closed
tags:
    - portolan
    - meeting
    - astra
depends-on:
    - constitution-portolan-meeting
    - meeting-candidate-felt-promotion
created-at: 2026-04-03T02:24:05.814328+02:00
closed-at: 2026-04-03T02:24:13.674122+02:00
outcome: 'Meeting candidate promotion now has an ASTRA lane for explicit decisions. When a decision-kind candidate is promoted from the Portolan meeting surface, MeetingBridge still creates the felt fiber but also upserts a corresponding decision record into astra.yaml with rationale and meeting provenance, records the ASTRA decision id in candidate-promotions.jsonl plus meeting metadata, and surfaces the ASTRA sync back in the HUD. Evidence: cd server && npx vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts; cd server && npm run build; npm run build.'
---

(meeting-decision-astra-promotion)=
Promote accepted meeting decision candidates into astra.yaml at the same moment they are promoted into felt, preserving live meeting provenance and keeping ASTRA as part of the same object continuum rather than a later manual export step.
