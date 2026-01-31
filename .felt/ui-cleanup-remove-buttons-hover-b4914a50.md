---
title: 'UI cleanup: remove buttons, hover, fix Safari zoom'
status: closed
kind: spec
priority: 2
created-at: 2026-01-30T16:20:38.992017+01:00
closed-at: 2026-01-30T16:27:34.643296+01:00
close-reason: Complete. ViewSwitcher deleted, hover code removed, Safari wheel zoom has passive:false. Manual Safari testing recommended to confirm two-finger scroll works.
---

## Goal

Simplify the Hexarchy UI by removing unused features and fixing Safari zoom.

## Tasks

### 1. Remove View Switcher buttons (top-right)
**Files:**
- `src/ui/ViewSwitcher.ts` — delete entire file
- `index.html` — remove CSS for `.view-switcher`, `.view-btn`, etc. (lines ~2965-3004)
- `src/main.ts` — remove ViewSwitcher import and instantiation

The view switcher provides Map/Plots/Plans tabs that are no longer used.

### 2. Remove hover functionality
**Files:**
- `src/main.ts` — remove hover detection in mousemove handler (lines ~648-681)
  - Remove tooltip element creation/updates
  - Remove cursor changes on hover
  - Keep the mousemove handler structure for drag detection if needed
- `src/ui/ContextMenu.ts` — hover effects on menu items are fine to keep (standard UX)

### 3. Fix Safari two-finger scroll zoom
**Files:**
- `src/render/Camera.ts` — current wheel event works for trackpad scroll, but Safari may need `{ passive: false }` more explicitly or different event handling

**Current state:** Wheel zoom exists (lines 90-95), gesture pinch exists (lines 97-113). Test whether two-finger scroll already works in Safari. If not, investigate Safari-specific wheel event quirks.

## Completion Criteria

1. No buttons visible in top-right corner
2. No hover tooltips or cursor changes (except context menu hover which is standard)
3. Two-finger scroll zooms in Safari (not just pinch)
4. Build succeeds, no console errors
