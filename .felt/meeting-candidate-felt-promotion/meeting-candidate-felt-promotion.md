---
title: Meeting candidate felt promotion
status: closed
tags:
    - portolan
    - meeting
    - astra
depends-on:
    - constitution-portolan-meeting
    - meeting-candidate-event-capture
created-at: 2026-04-03T02:19:50.614306+02:00
closed-at: 2026-04-03T02:19:58.251052+02:00
outcome: 'Portolan meeting runs can now promote accepted candidate events into the project''s felt continuum without leaving the live meeting surface. MeetingBridge creates a real fiber for the selected candidate event, records the promotion in candidate-promotions.jsonl plus meeting metadata, exposes POST /meeting-bridge/candidate/promote, and the HUD shows promotion status with direct open-fiber affordances. Evidence: cd server && npx vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts; cd server && npm run build; npm run build.'
---

(meeting-candidate-felt-promotion)=
Promote accepted meeting candidate events into the felt continuum directly from Portolan's meeting surface while preserving append-only meeting provenance. The promotion path should create a real fiber in the meeting city, record the promotion in meeting logs and metadata, and surface the resulting fiber back in the HUD so accepted structure does not stall at candidate-events.jsonl.
