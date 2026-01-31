---
title: 'UI: activity feed tool calls now expandable'
status: closed
kind: decision
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T18:28:05.968639+01:00
closed-at: 2026-01-31T18:28:05.968644+01:00
close-reason: |-
    Changed tool_use rendering from showing tool_use and tool_result as separate items to a unified expandable component:
    - Default: one line with tool name + summary (file path, command, pattern)
    - Click to expand: shows full formatted tool input + output section
    - Double-click on Read/Write/Edit opens the file

    tool_result messages are now associated with their tool_use via toolUseId and rendered inline. Separate tool-result-item rendering removed.
---
