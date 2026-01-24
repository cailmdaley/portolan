---
title: 'Decision: Full file path in annotation feedback format'
status: closed
kind: decision
priority: 2
created-at: 2026-01-24T00:45:10.076374+01:00
closed-at: 2026-01-24T00:45:10.076376+01:00
close-reason: |-
    Changed annotation format to include full file path instead of just filename.

    **Before:** `# Feedback on FileViewerModal.ts`
    **After:** `# Feedback on /Users/.../src/ui/FileViewerModal.ts`

    **Rationale:**
    - Claude needs full path to locate the file reliably
    - Filename alone is ambiguous in large codebases
    - Enables copy-paste of path for navigation

    When formatting code review feedback for LLMs, always include the complete file path.
---
