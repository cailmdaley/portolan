---
title: 'Gotcha: Claude startup timing for tmux send-keys'
status: closed
kind: spec
priority: 2
created-at: 2026-01-25T22:23:26.288121+01:00
closed-at: 2026-01-25T22:23:26.288131+01:00
close-reason: 'When sending messages to Claude via tmux send-keys (annotations, fiber context), must wait ~4 seconds for Claude to fully initialize. 2 seconds is insufficient, especially on remote systems. Affects: HttpApi.ts handleSendAnnotations, KittyIntegration.ts sendFiberContextAfterDelay.'
---
