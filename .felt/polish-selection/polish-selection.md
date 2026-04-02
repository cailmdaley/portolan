---
title: Polish + Selection
status: closed
tags:
    - hexarchy-v2
created-at: 2026-01-18T02:09:47.406005+01:00
closed-at: 2026-01-18T02:17:24.837607+01:00
---

(polish-selection)=
## Goal

Add selection highlight and polish rough edges. Most integration work is already done.

## What Already Works

- WebSocket client with reconnect (main.ts)
- State sync from server (cities, sessions)
- Click handling → Kitty focus
- Entity lookup (getEntityAtHex)
- City centering on click

## What's Missing

### 1. Selection Visual

When a hex is clicked, show a subtle highlight. Currently clicks work but there's no visual feedback.

**Approach:**
- Track `selectedHex: HexCoord | null` in main.ts
- Pass to ZoneRenderer or handle separately
- Highlight style: ochre glow ring, subtle — fits Cartographic Warmth

```typescript
// In main.ts
let selectedHex: HexCoord | null = null

canvas.addEventListener('click', (e) => {
  // ... existing logic ...
  selectedHex = hex
  zoneRenderer.setSelection(selectedHex)
})
```

```typescript
// In ZoneRenderer
private selectionRing: Mesh | null = null

setSelection(hex: HexCoord | null): void {
  // Remove old ring
  if (this.selectionRing) {
    this.scene.remove(this.selectionRing)
    this.selectionRing = null
  }

  if (hex) {
    // Create subtle ring at hex position
    // Use ochre/terracotta for warmth, not neon highlight
  }
}
```

### 2. Edge Cases

- Empty hex click → select but don't focus (already works, just add visual)
- Kitty not running → graceful failure (server logs error, browser unaffected)
- Server not running → mock data fallback (already implemented!)
- Rapid clicks → debounce or ignore if already focusing

### 3. Optional Refactor

Current state is inline in main.ts. Could extract to store.ts but it's working fine as-is. Only do this if the file gets unwieldy.

---

## Verification

- Click a worker → Kitty focuses AND hex shows selection ring
- Click a city → camera centers AND hex shows selection ring
- Click empty hex → selection ring appears, no focus attempt
- Click different hex → old selection clears, new one appears
- Server disconnect → "reconnecting" behavior, selection persists
- Kitty unavailable → click still works, just no focus

---

## Stopping Criteria

- Selection visual works and looks good (Cartographic Warmth style)
- All verification items pass
- No jarring behaviors or rough edges
- A full pass yields nothing to improve
- No edits were made in that final pass
