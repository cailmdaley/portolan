---
title: Artifact lightbox
tags: []
depends-on:
    - detail-panel-a4d1999b
created-at: 2026-02-21T19:27:17.602931+01:00
outcome: Clicking an artifact image opens a full-viewport overlay. Arrow keys and click cycle through all image artifacts for that node. In non-static mode, clicking the image places an annotation pin at the click coordinates.
---

The lightbox is opened by `openLightbox(img, node)`, triggered when the user clicks an artifact image in the detail panel. It creates a full-viewport overlay (`tapestry-lightbox` class) containing a large image, an optional label showing the artifact name and position (e.g., "residuals (2/5)"), and a close button.

Navigation between artifacts uses the `imageArtifacts()` helper, which filters the node's evidence artifacts to only those with image extensions (png, jpg, jpeg). The current `plotIndex` tracks position in this array. Arrow keys cycle through artifacts: `ArrowLeft` decrements, `ArrowRight` increments, both wrapping around via modular arithmetic `(plotIndex + delta + entries.length) % entries.length`. Each navigation updates `bigImg.src`, `bigImg.alt`, and the label text. Escape closes the lightbox.

The close behavior has multiple triggers: clicking the close button, pressing Escape, or clicking the backdrop (the lightbox div itself, checked via `e.target === lightbox`). The key handler is registered on `document` and removed in `close()` to prevent stale listeners.

In non-static mode (the live portolan, not GitHub Pages export), clicking the image itself triggers annotation placement. The click handler computes relative coordinates as percentages of image dimensions (`(clientX - rect.left) / rect.width * 100`) and passes them to `promptImageAnnotation()`, which opens the annotation dialog with the pin location pre-filled. The lightbox closes after the click to make room for the annotation form.
