---
title: Worker from fiber sends name before claude starts - should send felt show as first message
status: closed
kind: bug
priority: 2
created-at: 2026-01-25T17:53:48.538821+01:00
closed-at: 2026-01-25T18:05:39.182835+01:00
close-reason: 'Fixed handoff sequence in KittyIntegration.ts. Now: (1) starts Claude with felt on <id>, (2) waits 2s for startup, (3) fetches fiber content via felt show, (4) sends full fiber context as first message via tmux send-keys. Works for both local and remote cities.'
---

## Problem
When creating a worker from a fiber in city view, the sequence is wrong:
1. Opens kitty/tmux
2. Sends fiber name (before claude starts!)
3. Runs claude

The fiber name gets lost to the shell prompt, not to Claude.

## Expected
1. Opens kitty/tmux
2. Runs claude
3. Sends `felt show <fiber-id>` contents as first message
4. Include orientation sentence: 'This session was opened to work on this fiber:'

## Likely Fix
Reorder commands in KittyIntegration.ts - start claude first, then send message with fiber context.

## Files
- server/src/KittyIntegration.ts - fix command sequence
- server/src/MessageRouter.ts - may handle worker creation
