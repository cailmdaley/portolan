---
title: Scale PDF with sidebar
status: closed
tags:
    - portolan
depends-on:
    - pdf-artifact-support-in-tapestry
created-at: 2026-02-25T16:50:30.882364+01:00
closed-at: 2026-02-25T16:50:58.604612+01:00
outcome: Updated PDF gallery tile sizing to track sidebar width continuously (changed width from min(100%, calc(...)) to 100% in app and static templates), preserving aspect ratio via existing --pdf-aspect-ratio. This makes PDF tiles expand/shrink with sidebar resizing like images. Verified with npm run build.
---

(scale-pdf-with-sidebar)=
# Scale PDF with sidebar
