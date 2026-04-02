---
title: Annotated section should show 3 most-recently annotated files (even if cleared)
status: closed
created-at: 2026-01-25T17:50:27.526755+01:00
closed-at: 2026-01-25T18:12:44.460386+01:00
---

(annotated-section-should-show-3)=
## Problem
ANNOTATED section only shows files with *current* annotations. If user clears annotations, the file disappears from the list.

## Expected
Show 3 most-recently annotated files, even if annotations were later cleared. Provides navigation history.

## Likely Fix
Track annotation history (timestamp + filepath) separately from current annotations. Show top 3 by recency.

## Files
- server/src/AnnotationPersistence.ts - track history
- server/src/HttpApi.ts - return history in getCityContent
- src/ui/CityPanel.ts - display history
