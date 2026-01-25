---
title: 'Pattern: tmux load-buffer for multi-line content'
status: closed
kind: spec
priority: 2
created-at: 2026-01-25T23:53:20.502919+01:00
closed-at: 2026-01-25T23:53:20.502923+01:00
close-reason: 'When sending multi-line content to tmux sessions (especially over SSH), use load-buffer with stdin instead of send-keys with escaping. Avoids shell escaping hell with quotes, newlines, backticks. Pattern: execSync(''tmux load-buffer -'', { input: content }); execSync(''tmux paste-buffer -t session''); Implemented in KittyIntegration.ts (handoff) and HttpApi.ts (send-annotations).'
---
