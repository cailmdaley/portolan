---
title: Git status in CityPanel for local and remote cities
status: closed
kind: task
priority: 2
created-at: 2026-01-19T09:23:41.591087+01:00
closed-at: 2026-01-19T09:23:54.256704+01:00
close-reason: |-
    Implemented git status display in CityPanel for both local and remote cities.

    **Architecture:**
    - GitStatusManager tracks status per city path (not session) — cities = directories
    - Local cities: GitStatusManager polls every 5s
    - Remote cities: agent.js collects status, sends via WebSocket, stored in remoteGitStatuses Map keyed by 'originId:path'

    **Files added/modified:**
    - server/src/GitStatusManager.ts (new) — tracks git status per path
    - server/src/CityManager.ts — added gitStatus to City type
    - server/src/index.ts — wired up manager, broadcasts on status change
    - server/agent.js — added getGitStatus(), sends with session updates
    - src/state/types.ts — GitStatus interface
    - src/ui/CityPanel.ts — renderGitStatus() method
    - index.html — CSS for git status (light + dark theme)

    **Display format:**
    `main · ↑2 ↓1 · ●3 ○2 ?5 · +45 -12`
    - branch (teal), ahead/behind (gold), staged (green), unstaged (gold), untracked (muted), +/- (green/red)

    Ported from hexarchy v1 GitStatusManager but adapted for city-based tracking.
---
