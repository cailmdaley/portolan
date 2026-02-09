---
title: 'Claims annotation: inline annotate.js + postMessage bridge'
status: closed
kind: spec
priority: 2
depends-on:
    - decision-annotations-anchor-to-8eeba103
    - decision-claims-annotation-is-842112f3
    - decision-claim-annotations-use-a3efba10
    - decision-felt-is-optional-24b107b2
    - file-annotations-in-e8dbee22
    - pattern-postmessage-bridge-for-ddcc890c
created-at: 2026-02-07T01:26:59.298018+01:00
closed-at: 2026-02-07T05:48:17.612656+01:00
close-reason: |-
    Feature complete. Inline claims annotation with postMessage bridge, fully integrated.

    Implementation: claims-annotate.js (672 LOC injected script) provides text selection and image pin annotation in proxied dashboard iframes. ClaimsDashboard.ts (357 LOC) bridges postMessage to REST API. WorkerPicker.ts (70 LOC) shared between claims and file annotations. AnnotationPersistence extended with claimId/claimTitle/selectedText/artifact fields. HttpApi handles proxy injection (let/const→var, font/image/imgPath/lightbox src rewrites), annotation CRUD, formatClaimsAnnotationsForClaude, promote-to-felt, send-to-worker via tmux paste.

    Security: All SSH handlers use execFileAsync + shellEscape (zero shell injection surface). XSS: CSS.escape for selectors, escapeHtml for innerHTML, safeCityId for script injection. Image validation requires both x,y. Asset path traversal and shell injection blocked.

    Tests: 76 claims-specific + 39 annotation persistence = 115 directly relevant tests out of 224 total. Coverage includes proxy rewrite against realistic dashboard HTML, special character round-trips, shellEscape edge cases, format output verification.

    Downstream fibers closed: gotcha-ssh-double-quote, gotcha-let-const-globals, pattern-auto-bridge-injected, pattern-postmessage-bridge.
---

# Claims Annotation

Annotate claims inline in the dashboard, send feedback to workers via tmux paste.

## Design Principles

- Dashboard stays standalone and read-only when not in portolan
- Annotation is a portolan capability layered on top via script injection
- Annotations anchor to **claim title**, not file paths — Claude locates by title
- Uses existing send-to-worker infra (`POST /send-annotations`, `tmux load-buffer` + `paste-buffer`, no Enter)
- Uses existing `AnnotationPersistence` for storage (extends, not replaces)
- Felt is an optional "promote" destination, not the default

## How It Works

### In portolan (iframe)

1. Proxy rewriting injects `<script src="/claims-annotate.js"></script>` (already injects scripts at `<head>`)
2. `claims-annotate.js` detects it's in an iframe, activates annotation affordances
3. User selects text in a rendered claim card → inline comment input
4. User clicks a plot image → pin marker + comment input (same pattern as FileViewerModal image annotations)
5. Save → `postMessage` to portolan parent → portolan calls `POST /annotations`
6. Send to worker → `postMessage` to portolan parent → portolan calls `POST /send-annotations`

### Standalone (no portolan)

Dashboard renders normally. `claims-annotate.js` is not present (not injected). No annotation UI. Pure read-only.

## Data Model

Extend existing `Annotation` interface. The key difference: claims annotations use `claimId` + `claimTitle` instead of `filePath` + char offsets.

```typescript
// In AnnotationPersistence.ts — extend Annotation
interface Annotation {
  // ... existing fields (filePath, from, to, etc.) ...

  // Claims annotation fields (optional, mutually exclusive with filePath anchoring)
  claimId?: string        // fiber ID (e.g., "b-modes-claim-abc123")
  claimTitle?: string     // human-readable (e.g., "B-modes consistent with zero")
  selectedText?: string   // text the user highlighted in the rendered claim
  artifact?: string       // plot filename if annotating an image (e.g., "b_modes.png")
  isClaimAnnotation?: boolean
}
```

Storage: same `~/.portolan/annotations.json`. Filtered by `isClaimAnnotation` for claims-specific queries.

## Pieces

### 1. `claims-annotate.js` (~690 lines vanilla JS)

Served by portolan at `/claims-annotate.js`. Injected into dashboard HTML during proxy rewriting.

**Text annotation:**
- Listens for `mouseup` on `.claim-modal-content` (the claim detail panel)
- If `window.getSelection()` has content → show inline annotation input
- Input: small textarea + Save button, positioned near selection
- On save: `parent.postMessage({ type: 'claims-annotation-save', claimId, claimTitle, selectedText, comment }, '*')`

**Image annotation:**
- Listens for `click` on artifact `<img>` elements in claim modals
- Records click position as percentage (same as FileViewerModal pattern)
- Shows pin marker + annotation input
- On save: `parent.postMessage({ type: 'claims-annotation-save', claimId, claimTitle, artifact, x, y, comment }, '*')`

**Load existing:**
- On claim modal open: `parent.postMessage({ type: 'claims-annotation-load', claimId }, '*')`
- Parent responds with annotations array
- Script renders markers/highlights for existing annotations

**Send to worker:**
- Button in annotation UI: "Send to Worker"
- `parent.postMessage({ type: 'claims-annotation-send', claimId, cityId }, '*')`
- Portolan handles worker picker + tmux paste (existing UI)

### 2. Auto-bridging (no template changes needed)

`claims-annotate.js` auto-detects claim context from dashboard globals (`currentClaimId`, `claimGraph`) and injects data attributes via MutationObserver. Three-layer fallback:

1. Explicit `data-claim-id` / `data-claim-title` / `data-artifact` (forward-compatible)
2. DOM containment: if element is inside `#claim-panel`, read `window.currentClaimId` + `window.claimGraph[id].data.claim`
3. Derive artifact from image `src` filename (last path segment, image extensions)

This eliminates coupling to the consumer template — dashboards work as-is.

### 3. Portolan parent listener (~30 lines in main.ts or ClaimsDashboard.ts)

Listen for postMessage from the claims iframe:

```typescript
window.addEventListener('message', (event) => {
  if (event.data.type === 'claims-annotation-save') {
    // POST /annotations with isClaimAnnotation: true
  }
  if (event.data.type === 'claims-annotation-load') {
    // GET /annotations?claimId=X → postMessage back
  }
  if (event.data.type === 'claims-annotation-send') {
    // Open worker picker, then POST /send-annotations
  }
})
```

### 4. Server annotation endpoints (small extensions)

**AnnotationPersistence:**
- Add `getByClaimId(claimId: string)` method
- Accept claims annotation fields in `add()`

**HttpApi:**
- Existing `GET/POST/DELETE /annotations` endpoints work as-is (just new fields)
- `formatAnnotationsForClaude` gets a claims-specific format:

```markdown
# Claims review: pure-eb

## B-modes consistent with zero
> "PTE 0.29" — seems low, recheck with different bin edges

## Galaxy generation pipeline
> (galaxy_fields.png at 45%, 32%) — check edge effects on velocity
```

### 5. Proxy injection (1 line change in HttpApi.ts)

In `handleClaimsDashboard`, add to the existing `<head>` injection:

```typescript
.replace(/<head>/i, `<head>
  <script>window.CLAIMS_ASSETS_BASE = "${assetsBase}"; ...</script>
  <script src="/claims-annotate.js"></script>
`)
```

## Format for Workers

When sent to a worker via tmux paste:

```markdown
# Claims review: {cityName}

I've reviewed the claims dashboard and have {n} pieces of feedback:

## 1. [B-modes consistent with zero]
> On text: "PTE 0.29"
> Seems low — recheck with different bin edges

## 2. [Galaxy generation pipeline]
> On plot: galaxy_fields.png (at 45%, 32%)
> Check edge effects on velocity profile

---
```

Pastes without Enter. User can review, add more, then submit manually.

## Promote to Felt

Optional action on individual annotations. Calls `felt comment <claimId> "text"`. Not the default path — most annotations are ephemeral review notes that live and die with the review session.

## What This Doesn't Do

- No annotation when dashboard is standalone (by design)
- No markdown render mode in FileViewerModal (not needed for this feature)
- No new storage format (extends existing annotations.json)
- No hook-based injection (uses existing tmux paste pattern)

## Implementation Status

Feature complete across 11 iterations. 224 tests, TS clean.

**Files:**
- `server/public/claims-annotate.js` — 689 LOC injected script (text+image annotation, auto-bridge, CSS)
- `src/ui/ClaimsDashboard.ts` — postMessage bridge (save/load/delete/promote/send)
- `src/ui/WorkerPicker.ts` — shared worker picker (extracted from FileViewerModal+ClaimsDashboard)
- `server/src/AnnotationPersistence.ts` — claims fields + getByClaimId/getAllClaims
- `server/src/HttpApi.ts` — proxy rewrite, endpoints, formatClaimsAnnotationsForClaude

**Security:** All SSH handlers use execFileAsync+shellEscape (zero execAsync SSH calls). XSS: CSS.escape for selectors, escapeHtml for innerHTML, safeCityId for injection. Image validation (artifact requires x,y).

**Proxy rewrites:** font url(), static img src, dynamic imgPath construction, lightbox src: property, let/const→var for bridge globals (currentClaimId, selectedClaimId, claimGraph). Verified against realistic KineLens dashboard HTML structure in tests.

**UX:** Toasts, Cmd+Enter save, Escape dismiss, pin popovers, send-all header button, promote-to-felt with visual feedback. Iframe error handling: 15s timeout, onerror, error CSS state.

**Iteration history:** See `git log --oneline --grep="Claims annotation"` (commits 499e3d0..d0ca80d).
