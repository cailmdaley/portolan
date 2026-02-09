---
title: 'Decision: image annotation gated behind fullscreen lightbox'
status: closed
kind: decision
priority: 2
depends-on:
    - claims-annotation-side-panel-f290eeb2
created-at: 2026-02-07T21:11:48.060854+01:00
closed-at: 2026-02-07T21:11:48.060862+01:00
close-reason: 'Inline images in claim view are capped at 50vh height + 100% width, cursor: zoom-in. Clicking opens a fullscreen dark overlay (pa-lightbox) where the image displays at up to 90vw/85vh. Only in this lightbox can you place annotation pins (crosshair cursor). This separates browsing from annotating — prevents accidental pin placement, gives more precision for placement on large figures, and avoids z-index issues with popovers near viewport edges. Lightbox auto-closes after annotation save (renderVisualMarkers calls closeLightbox). Existing pins render in lightbox for context.'
---
