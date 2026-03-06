---
title: Extract TapestryView detail UI modules
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-06T16:59:14.981494+01:00
outcome: 'On March 6, 2026, extracted the static export file viewer and artifact lightbox out of src/ui/TapestryView.ts into src/ui/TapestryStaticFileModal.ts and src/ui/TapestryArtifactLightbox.ts. The change keeps behavior the same while removing the modal and lightbox DOM/event lifecycles from the main view class. Verified with npm run build. Commit: f062253.'
---
