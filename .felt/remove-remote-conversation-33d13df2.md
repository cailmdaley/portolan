---
title: Remove remote conversation proxy and wire file-touch HTTP hook in remote install
status: closed
tags:
    - portolan
depends-on:
    - constitution-http-hooks-file-c8cc25bf
created-at: 2026-03-02T04:18:21.656048+01:00
closed-at: 2026-03-02T04:18:26.367083+01:00
outcome: 'Removed the remote agent conversation proxy path: deleted hook server endpoints (/hook/message, /hook/health), transcript polling/read logic, and agent_conversation forwarding from server/agent.js. Updated scripts/install-remote.sh to ensure ~/.claude/settings.json includes PostToolUse HTTP hook matcher Read|Write|Edit -> http://localhost:4004/hook/file-touch while preserving command hooks for activity tracking. Updated CLAUDE.md architecture/debug/remote-hook guidance to file-touch model and removed stale conversation-specific gotchas. Verified with node --check server/agent.js, bash -n scripts/install-remote.sh, rg scan for legacy runtime references (no matches in active code/docs touched), and server test suite target HttpApi.file-touch.test.ts (6/6 passing).'
---

Purge remaining active/runtime references to conversation hook proxy paths (agent hook server :4005, transcript polling fallback, stale setup instructions) and align remote install/settings flow with PostToolUse HTTP file-touch hook.
