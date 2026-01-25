---
title: Image annotations not persistable - only text files support annotations
status: closed
kind: task
tags:
    - '[hexarchy]'
priority: 2
created-at: 2026-01-25T17:02:51.00682+01:00
closed-at: 2026-01-25T17:31:31.169318+01:00
close-reason: Resolved by click-to-annotate implementation in click-to-annotate-for-images-in-7e3be97a. Images now support persistent annotations via click-based point markers.
---

## Problem
The FileViewerModal's annotation system only works for text files (via text selection). Images show an ANNOTATIONS panel but you can't create annotations because there's no text to select.

## Current State
- Text files: Select text → add comment → annotation saved to ~/.hexarchy/annotations.json
- Images: Can only add "Overall Feedback" which is ephemeral (used for fiber creation only)

## Related Fiber
`click-to-annotate-for-images-in-7e3be97a` - proposes click/drag to annotate image regions

## Impact
Remote research projects (like pure_eb) have many image files (figures, plots) that would benefit from annotations but currently can't be annotated persistently.
