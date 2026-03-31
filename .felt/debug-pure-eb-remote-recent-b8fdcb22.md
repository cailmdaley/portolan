---
title: Debug pure_eb remote recent-files
status: closed
created-at: 2026-03-15T23:18:10.556128+01:00
closed-at: 2026-03-15T23:20:20.147889+01:00
outcome: Remote pure_eb recent-file hovers were empty because RecentFileTracker was only populated via /hook/file-touch, while remote worker activity was already arriving through agent_activity and the recent-file store stayed empty after restart. Wired RemoteAgentCoordinator.handleAgentActivity to record Read/Write/Edit fullPath touches directly into RecentFileTracker, which covers remote Codex workers without relying on Claude PostToolUse hooks. Verified with a focused RemoteAgentCoordinator test, HttpApi file-touch tests, and npm run build. Portolan server restart required to activate the change.
---
