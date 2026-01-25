---
title: Annotation options UI too dense - buttons visually indistinct
status: closed
kind: bug
priority: 2
created-at: 2026-01-25T17:50:27.663818+01:00
closed-at: 2026-01-25T18:01:12.100759+01:00
close-reason: |-
    Fixed in index.html. Added distinctive colors to buttons:

    **Top bar buttons (FileViewerModal):**
    - File as Fiber: gold/amber gradient (matches fiber aesthetic)
    - Send to Worker: teal gradient (matches worker badges)
    - Save: green gradient (affirmative action)
    - Copy/Refresh: remain muted (secondary actions)

    **Annotation action buttons:**
    - Send to Worker: teal background with border
    - Edit: gold/amber background with border
    - Delete: reddish background with border
    - Increased padding, gap, and added transitions

    All buttons now have clear visual hierarchy - primary actions pop, secondary actions recede. Color coding creates instant recognition of button purpose.
---

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
