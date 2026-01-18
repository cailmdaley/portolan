---
title: 'dev.sh script: clean ports, run frontend + backend'
status: closed
kind: task
priority: 2
created-at: 2026-01-18T13:57:49.073805+01:00
closed-at: 2026-01-18T13:57:54.806586+01:00
close-reason: 'Created dev.sh at project root. Kills processes on ports 5173 (frontend) and 4004 (backend), then launches both servers in subshells with proper directory context. Trap handles Ctrl+C cleanup. Usage: ./dev.sh'
---
