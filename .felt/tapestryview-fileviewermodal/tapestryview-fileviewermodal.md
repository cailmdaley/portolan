---
title: TapestryView / FileViewerModal consistency pass
tags:
    - portolan
created-at: 2026-02-20T02:16:22.081581+01:00
outcome: 'Six gaps closed between TapestryView detail panel and FileViewerModal fiber view: (1) STALENESS_COLORS, formatFiberDate, renderArtifactGallery extracted to utils.ts as shared foundations. (2) TapestryView: kind badge always shown (removed \!== ''task'' guard), timestamps (Filed · Closed) added to detail-meta row, artifact gallery refactored to closure-based renderArtifactGallery — currentPlotIndex instance field and updateArtifact() method removed. (3) Lightbox now uses local plotIndex (no shared state with gallery). (4) FileViewerModal: tapestry fetch extended to add staleness color on status span, downstream deps section, artifact gallery, evidence metrics; tag filter excludes tapestry: prefix tags; formatDate replaced with shared formatFiberDate. (5) CSS: .detail-dates added; .config-resolved and .md-inline-code[title] specificity fixed so teal color wins over .tapestry-detail-body code and .file-viewer-markdown code context rules.'
---

(tapestryview-fileviewermodal)=
# TapestryView / FileViewerModal consistency pass
