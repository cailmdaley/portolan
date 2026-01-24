---
title: 'Pattern: Worker picker with ''New Worker'' option'
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T00:45:01.06515+01:00
closed-at: 2026-01-24T00:45:01.065151+01:00
close-reason: |-
    When building UI to pick a worker for sending content (annotations, commands, etc.), always include a 'New Worker' option at the top:

    ```html
    <button class='worker-picker-item worker-picker-new' data-action='new'>
      <span class='worker-name'>+ New Worker</span>
      <span class='worker-session'>Create new worker and send</span>
    </button>
    <!-- existing workers follow -->
    ```

    **Server-side:** Accept either `workerId` (existing) or `createNewWorker: true` flag. When creating new worker:
    1. Create tmux session with claude
    2. Wait ~2 seconds for Claude to start up
    3. Send the content via tmux send-keys
    4. Open kitty tab and focus

    This eliminates the friction of 'no workers available' state and lets users create on-demand.
---
