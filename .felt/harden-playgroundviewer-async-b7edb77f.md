---
title: Harden PlaygroundViewer async lifecycle and teardown ownership
status: closed
tags:
    - task
depends-on:
    - constitution-portolan-da3b0f59
created-at: 2026-03-01T17:14:42.500776+01:00
closed-at: 2026-03-01T17:16:00.893223+01:00
outcome: 'Hardened src/ui/PlaygroundViewer.ts lifecycle ownership for async show/hide flows by adding AbortController-backed request ownership, monotonic request IDs, stale completion guards for fetch/iframe load, and deterministic hide-timeout cleanup across hide/dispose. This prevents stale completions from mutating hidden/disposed UI during rapid open/close/navigation loops. Evidence: npm run build passed; cd server && npm test && npm run build passed (244 tests).'
---
