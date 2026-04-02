---
title: 'Force Touch: focus terminal / new worker'
status: closed
created-at: 2026-01-30T16:28:56.655111+01:00
closed-at: 2026-01-30T16:29:44.066515+01:00
---

(force-touch-focus-terminal-new)=
## Goal

Add Force Touch (pressure-based haptic click) as the primary action gesture.

## Behavior

| Target | Force Touch action |
|--------|-------------------|
| Worker | Focus terminal in Kitty |
| Empty tile | Open new worker dialog |

## Implementation

### WebKit Force Touch events
```typescript
// Claim the gesture to prevent system Quick Look
element.addEventListener('webkitmouseforcewillbegin', (e) => {
  e.preventDefault()
})

// Detect force click threshold crossed
element.addEventListener('webkitmouseforcedown', (e) => {
  // Action fires here — user has pressed hard enough
})
```

### Key files
- `src/main.ts` — add force touch handlers alongside click handlers
- May need to track which entity is under cursor at force-down time

### Notes
- Force Touch gives haptic feedback automatically when threshold crossed
- Works on Mac trackpads only (graceful no-op elsewhere)
- Replaces old double-click behavior for these two actions
