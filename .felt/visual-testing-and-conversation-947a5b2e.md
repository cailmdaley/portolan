---
title: Visual testing and conversation card polish
status: open
kind: spec
priority: 2
depends-on:
    - murmuration-workers-68674cb9
created-at: 2026-02-03T23:51:38.103961+01:00
---

# Draft — To be shaped after murmuration-workers-68674cb9

## Scope (rough)

**Visual testing with Claude --chrome:**
- Chat message sending works (local + remote cities)
- File search works reliably (local + remote)
- Uses Chrome extension for visual debugging

**Conversation card polish:**
- Softer edges, less boxy
- Micro-interactions (hover states, transitions)
- Text aesthetics beyond just EB Garamond font
- Aligned with Portolan's cartographic warmth

## Dependencies

Depends on: `murmuration-workers-68674cb9` (workers need to be swarms first, affects how cards attach)

## Skills

- `/frontend-design` for card aesthetics
- Claude `--chrome` for visual testing
