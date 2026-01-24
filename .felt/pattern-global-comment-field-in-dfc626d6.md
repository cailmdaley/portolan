---
title: 'Pattern: Global comment field in annotation/review workflows'
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T00:44:46.671831+01:00
closed-at: 2026-01-24T00:44:46.671832+01:00
close-reason: |-
    When sending code feedback (annotations, reviews), include an optional 'global comment' or 'overall feedback' field alongside individual line annotations.

    **UI implementation:**
    - Place textarea above the action buttons in modal/picker
    - Label as 'Overall feedback (optional)' or similar
    - Keep it concise (2-3 rows)

    **Format output:**
    ```
    # Feedback on /full/path/to/file.ts

    [Global comment here if provided]

    I've reviewed this file and have N pieces of feedback:

    ## 1. Feedback on: "selected text"
    > comment
    ```

    This gives reviewers a place for context that doesn't fit on any specific line.
---
