---
title: Meeting live assistant egress
status: closed
tags:
    - portolan
    - meeting
    - assistant
    - hooks
depends-on:
    - constitution-portolan-meeting
created-at: 2026-04-03T02:32:37.134107+02:00
closed-at: 2026-04-03T02:36:49.117858+02:00
outcome: 'Portolan meeting runs now surface assistant egress alongside transcript ingress. The Claude hook script parses assistant text blocks from Stop-hook transcript tails and posts them through a new /hook/assistant-turn endpoint; HttpApiHooksRuntime resolves the worker session via the existing hook mapping path and MeetingBridge persists assistant-responses.jsonl with transcript/hook provenance, recent assistant state, and websocket-visible counters/previews. The HUD live thread now renders assistant replies directly and exposes the raw assistant reply log next to transcript, operator, candidate, and retrieval logs. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts src/__tests__/HttpApi.file-touch.test.ts src/__tests__/HttpApi.meeting.test.ts src/__tests__/BrowserStateCoordinator.test.ts; npm --prefix server run build; npm run build.'
---

(meeting-live-assistant-egress)=
Surface worker assistant replies back into the Portolan meeting lane using the existing hook/session resolution path. Persist assistant turn snippets with provenance under the active meeting run and render them in the HUD live thread so the meeting surface is no longer ingress-only.
