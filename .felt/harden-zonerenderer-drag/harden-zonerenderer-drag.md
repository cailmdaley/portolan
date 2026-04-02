---
title: Harden ZoneRenderer drag lifecycle ownership
status: closed
tags:
    - task
depends-on:
    - constitution-portolan
created-at: 2026-03-01T17:44:19.913842+01:00
closed-at: 2026-03-01T17:45:34.703553+01:00
outcome: 'Hardened src/render/ZoneRenderer.ts drag lifecycle ownership: document-level mousemove/mouseup handlers are now attached through single-owner attach/detach helpers, active drag reset timeout is explicitly owned/cleared, starting a new drag cancels any stale drag state, and dispose() now cancels active drag/listeners and clears callback references. Added runtime diagnostics fields for drag-listener attachment and pending drag-reset timeout to make teardown verifiable. Evidence: npm run build passed.'
---

(harden-zonerenderer-drag)=
# Harden ZoneRenderer drag lifecycle ownership
