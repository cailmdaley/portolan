---
title: 'Insight: Browser automation typing vs form_input'
status: closed
kind: spec
priority: 2
created-at: 2026-01-23T23:55:34.07406+01:00
closed-at: 2026-01-23T23:55:34.07406+01:00
close-reason: |-
    When automating browser forms with Claude-in-Chrome:

    **Problem:** The 'type' action may not go into the expected element if:
    - Focus shifted to CodeMirror or other complex component
    - z-index issues with overlays
    - Event capture by parent elements

    **Solution:** Use form_input tool with element ref:
    ```
    mcp__claude-in-chrome__find → get ref (e.g., ref_463)
    mcp__claude-in-chrome__form_input(ref, value, tabId)
    ```

    This directly sets the value on the DOM element, bypassing focus/event issues.

    **Discovered during:** FileViewerModal annotation testing - textarea appeared focused but typing went elsewhere.
---
