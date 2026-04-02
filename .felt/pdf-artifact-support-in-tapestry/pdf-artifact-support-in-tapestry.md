---
title: PDF artifact support in tapestry
status: closed
tags:
    - portolan
created-at: 2026-02-25T15:47:22.698083+01:00
closed-at: 2026-02-25T16:23:01.359095+01:00
outcome: Completed PDF artifact support in tapestry. EvidenceReader now includes .pdf outputs; artifact gallery carousel mixes images and PDFs with shared arrow/nav behavior; clicking either images or PDFs opens lightbox with media-appropriate element (img/iframe); static/export templates mirror the same behavior. Added PDF click overlay for reliable lightbox open from iframe tiles, page-aspect sizing via MediaBox probe for sidebar fit, and load-state smoothing to reduce switch flash. Annotation pinning remains image-only as intended. Existing image behavior preserved. Residual spacing/chrome inside PDF tiles/lightbox is browser PDF viewer UI and is accepted.
---

(pdf-artifact-support-in-tapestry)=
## Desired State

The tapestry artifact gallery renders PDFs alongside images. A PDF artifact appears in the same carousel as PNGs/JPEGs — navigable with the same arrow keys/nav controls. PDFs display as embedded iframes in the gallery and lightbox. No new dependencies.

When done:
- An `evidence.json` with `"output": {"report": "summary.pdf"}` produces a gallery entry
- The gallery carousel cycles through images and PDFs interchangeably
- Clicking a PDF artifact in the gallery opens it full-size in the lightbox (iframe, not `<img>`)
- The static/exported tapestry handles PDFs identically
- Existing image-only behavior is unchanged — no regressions

Leave alone: annotation pinning on PDFs (doesn't make sense for iframes), linked-file modal (already works for PDFs).

## Context

Three files, three touches:

1. **`server/src/EvidenceReader.ts:45`** — `IMAGE_RE = /\.(png|jpe?g)$/i` filters evidence outputs. Rename to `ARTIFACT_RE`, extend to `/\.(png|jpe?g|pdf)$/i`. Update the comment on line 6 and the `artifacts` type comment (line 20) to say "images and PDFs" not "images only."

2. **`src/ui/utils.ts:228` `renderArtifactGallery()`** — Currently emits `<img>` unconditionally. Needs to check the file extension: `<img>` for images, `<iframe>` for PDFs. The `updateImg()` closure (line 249) must also switch element type or swap `src` on the right element. The label and nav controls stay the same.

3. **`src/ui/TapestryView.ts`** — Two areas:
   - `imageArtifacts()` (line 138) — rename to `artifactEntries()` since it's no longer image-specific. Used at lines 1748, 1852, 2356.
   - Lightbox (`openLightbox`, ~line 2350) — currently creates `<img>`. For PDFs, create `<iframe>` instead. The `.tapestry-artifact img` click listener (line 1859) needs to also match iframes.
   - Annotation pinning listener (line 2420) should skip PDFs — no `(x, y)` pinning on iframes.

Server artifact serving (`HttpApi.ts`) already handles PDFs (line 704 `fileType = ext === 'pdf' ? 'pdf' : 'image'`). No backend changes needed.

## Evidence

```bash
# After changes, verify:
cd server && npm test                    # existing tests pass
# Then manually: open a tapestry with a claim whose evidence.json has a PDF output
# Confirm it appears in the gallery and opens in lightbox
```

## Open Questions

None — scope is small and clear.
