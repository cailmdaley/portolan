---
title: 'Pattern: jq conditional field extraction in bash hooks'
status: closed
kind: spec
priority: 2
depends-on:
    - claude-code-hooks-available-1046dad3
created-at: 2026-01-31T02:40:32.2523+01:00
closed-at: 2026-01-31T02:40:32.252305+01:00
close-reason: |-
    In hexarchy-hook.sh, a single jq call handles multiple event types by using conditionals:
    ```jq
    if .tool_name then
      { tool: .tool_name, toolInput: .tool_input }
    elif .prompt then
      { prompt: .prompt }
    else {}
    end
    ```
    This avoids multiple jq invocations and keeps the shell script efficient. Each event type contributes its specific fields to the output JSON.
---
