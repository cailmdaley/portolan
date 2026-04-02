---
title: Annotation options UI too dense - buttons visually indistinct
status: closed
created-at: 2026-01-25T17:50:27.663818+01:00
closed-at: 2026-01-25T18:01:12.100759+01:00
---

(annotation-options-ui-too-dense)=
## Problem
FileViewerModal top bar has many buttons all same cream color:
`plaintext | Save | File as Fiber | Send to Worker | ⟳ | Copy | ×`

Dense, hard to visually parse at a glance.

## Expected
Visual hierarchy through:
- Color: primary actions (Save) vs secondary (Copy)
- Grouping: related actions together
- Icons: reduce text, improve scannability

## Ideas
- 'File as Fiber' = gold/amber (matches fiber aesthetic)
- 'Send to Worker' = teal (matches worker badges)
- 'Save' = green (affirmative)
- 'Copy' = muted/gray
- Add icons where helpful

## Files
- index.html - button styles in FileViewerModal CSS
