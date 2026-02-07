---
title: 'Claims annotation: inline annotate.js + postMessage bridge'
status: active
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

## Comments
**2026-02-07 02:00** — Loop 1: Built core pipeline — Annotation data model (claimId/claimTitle/selectedText/artifact/isClaimAnnotation fields), getByClaimId(), claims-annotate.js (vanilla JS, text+image annotation in iframe), postMessage bridge in ClaimsDashboard.ts, /claims-annotate.js endpoint, proxy injection, claims-specific Claude format. File-anchoring fields made optional. 331 LOC in injected script. TypeScript compiles clean, 112 tests pass. Dashboard template data-attributes still needed from consumer side.
**2026-02-07 02:07** — Loop 2: 37 AnnotationPersistence tests (CRUD, claims/file separation, round-trip, getByClaimId, getRecentFiles). Send-to-worker fully wired: ClaimsDashboard.showWorkerPicker → sendClaimsToWorker → POST /send-annotations with isClaimsSend. Injected script gains 'Send to Worker' button on claim panels with annotations. main.ts wires setOnGetWorkers. Removed stale file-annotation fields from claims save. Code simplifier cleaned redundant || undefined guards.
**2026-02-07 02:20** — Loop 3: Fixed 2 pre-existing ConversationCache test failures (timestamp sort order, ISO timestamps for trim test). Added 17-test HttpApi claims suite (POST/GET/DELETE endpoints, formatClaimsAnnotationsForClaude format output, CRUD round-trip, claims-annotate.js endpoint). Fixed pin lifecycle: pins persist on save via _saved flag, parent triggers reload after successful save so permanent markers replace temp pins, renderExistingAnnotations clears both marker classes. Code simplifier: removed redundant guards, property shorthand, makeClaimAnnotation factory. 168 tests pass, TS clean.
**2026-02-07 03:30** — Loop 4: UX feedback (toast on save/delete/send), delete annotations from iframe (× on text badges, right-click on image pins), 'Send All to Worker' header button with GET /annotations?claims=true endpoint, getAllClaims() persistence method, image annotation validation (reject artifact without x,y), 9 new tests (177 total). Code simplifier: extracted fetchApi()/fetchAnnotationsAndPickWorker() in ClaimsDashboard, consolidated isFileAnnotation in add(), replaced nested ternary, hoisted SSH lookup.
**2026-02-07 03:40** — Loop 5: Promote-to-felt endpoint (POST /promote-to-felt, felt comment via execAsync, local+remote), postMessage bridge (claims-annotation-promote), image pin click popover (comment+promote+delete), promote button on text badges. Code simplifier: postAnnotationMessage/addHoverFade/createPopoverActionBtn helpers, parseJsonBody pattern in handler. 3 new tests (180 total). 251 LOC added.
**2026-02-07 03:53** — Loop 6: Extract shared WorkerPicker.ts (dedup 50 LOC from FileViewerModal+ClaimsDashboard), formatClaimsAnnotationsForClaude groups by claim title, promote feedback via annotationId through postMessage bridge, data-annotation-id on markers. Code simplifier: clampToViewport helper, fetchApi consistency, if/else if. 181 tests, TS clean.
**2026-02-07 04:04** — Loop 7: CSS extraction (530-line inline styles → <style> block with classes), XSS safety (CSS.escape on querySelector selectors for claimId/annotationId/artifact), Cmd+Enter save shortcut, Escape clears selection. addHoverFade/showPromotedFeedback now CSS-only. HttpApi: converted all annotation handlers + handleSaveFile/handleSendAnnotations/handleSendMessage/handleFileAsFiber to parseJsonBody/sendJsonError/sendJsonSuccess (-85 lines). 181 tests, TS clean.
**2026-02-07 04:51** — Loop 8: Needs sync/test with remote dashboards (pure_eb, KineLens). Their HTML was generated before the annotation system existed — variable names differ (selectedClaimId vs currentClaimId), and the auto-bridge assumptions may not fully hold. Rebuilding dashboards with updated research skill code would align them. Current proxy rewrites handle both variants but this is untested end-to-end on remote.
**2026-02-07 05:08** — Loop 9: SSH hardening — converted handleClaimsDashboard and handleClaimsAssets from execAsync (shell interpolation) to execFileAsync+shellQuote (bypasses local shell), completing the pattern from gotcha-ssh-double-quote across all claims proxy handlers. Iframe error handling: load timeout (15s), onerror handler, error CSS state — replaces infinite spinner on failure. Code simplifier: extracted clearLoadTimeout(), loading boolean flag, hoisted test helpers (formatClaims, makeCityLookup), shellQuote reuse in tmux handlers. 5 new tests (210 total), TS clean.
**2026-02-07 05:28** — Loop 10: Extended SSH hardening to ALL remaining handlers across HttpApi.ts and index.ts — handleFileContent, handleBinaryContent, handleActivateCity, handlePlaygroundList, handlePlayground, writeRemoteFile, getRemoteFibers, searchRemote. Fixed unquoted `kind` param in handleFileAsFiber (shell injection via JSON body). Code simplifier: consolidated private shellQuote into shared shellEscape from KittyIntegration (eliminated duplicate function + manual wrapping pattern). 4 new shellQuote tests (214 total), TS clean. Zero `execAsync` SSH calls remain in codebase.

