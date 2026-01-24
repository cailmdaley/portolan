---
title: 'Pattern: Store line numbers in annotations at creation time'
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T01:08:54.761666+01:00
closed-at: 2026-01-24T01:08:54.761667+01:00
close-reason: 'Calculate line number when saving annotation using CodeMirror''s doc.lineAt(from).number (1-indexed). Store as optional field for backwards compatibility. More efficient than re-reading file at format time. Used in both UI display (L42 badge) and sent format (## 1. (L42) Feedback on: ...).'
---
