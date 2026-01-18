---
title: Server index.ts (HTTP + WebSocket wiring)
status: closed
kind: task
tags:
    - ralph:1
priority: 2
depends-on:
    - server-14a1cdf1
created-at: 2026-01-18T00:27:29.240543+01:00
closed-at: 2026-01-18T00:30:34.0946+01:00
close-reason: 'Implemented server/index.ts (224 LOC) that wires together SessionTracker (205 LOC), CityManager (308 LOC), and FiberReader (51 LOC). Total server implementation: 788 LOC. Key features: WebSocket state broadcast, session change handling with auto-city-creation, Kitty focus integration via kitty @ remote control, fiber count injection into cities. Server polls tmux every 2s, broadcasts state changes to all clients, handles focus messages from browser to switch terminal tabs.'
---
