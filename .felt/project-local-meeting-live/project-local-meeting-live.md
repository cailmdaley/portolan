---
title: Project-local meeting live document lane
status: closed
tags:
    - meeting
    - astra
    - mystra
depends-on:
    - constitution-portolan-meeting
    - meeting-live-document-surface
    - meeting-live-astra-lane
created-at: 2026-04-03T03:23:29.093213+02:00
closed-at: 2026-04-03T03:23:35.711185+02:00
outcome: 'MeetingBridge now prefers a project-local meeting-live-brief.md beside astra.yaml when the worker city path exists, while falling back to the per-run meeting directory when the workspace path is unavailable. The live document markdown now carries clickable evidence locators, promoted fiber paths, and explicit live-ASTRA provenance, so the ASTRA/MySTRA lane is a better primary meeting surface instead of just a log pointer. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.meeting.test.ts; npm --prefix server run build; npm run build.'
---

(project-local-meeting-live)=
Prefer the live meeting document as a stable project-local object beside astra.yaml when the city workspace exists, while preserving the per-run meeting directory as fallback provenance. The generated markdown should expose clickable evidence and promotion locators so the live document itself carries the meeting thread's navigation surface instead of acting like a thin wrapper around hidden logs.
