---
title: Worker from fiber sends name before claude starts - should send felt show as first message
status: closed
created-at: 2026-01-25T17:53:48.538821+01:00
closed-at: 2026-01-25T18:05:39.182835+01:00
---

(worker-from-fiber-sends-name)=
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
