---
title: Extend hexarchy-hook.sh to capture user prompt field
status: closed
kind: task
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T02:37:45.506837+01:00
closed-at: 2026-01-31T02:40:04.90299+01:00
close-reason: |-
    Implemented user prompt capture in hexarchy-hook.sh. Changes:
    1. hexarchy-hook.sh now extracts .prompt field from UserPromptSubmit events
    2. EventWatcher.ts stores user prompts as activities with eventType='user_prompt'
    3. WorkerActivityPanel.ts displays user prompts with 'You' badge in gold
    4. types.ts Activity interface extended with eventType and prompt fields

    User prompts now appear in the activity feed alongside tool calls. Still missing: assistant responses and thinking blocks (would need transcript file reading).
---
