---
title: 'Claims annotation: side panel refactor — iframe selection + parent panel'
status: closed
kind: spec
priority: 2
depends-on:
    - claims-annotation-inline-bba0fc30
created-at: 2026-02-07T21:11:32.218871+01:00
closed-at: 2026-02-07T21:11:32.218874+01:00
close-reason: |-
    Refactored claims annotation architecture. Before: iframe owned all annotation UI (inputs, badges, send bars, popovers). After: iframe handles only selection detection + visual markers; parent ClaimsDashboard owns annotation list panel, global feedback, and CRUD.

    New structure: .claims-dashboard-body flexbox row with .claims-dashboard-content (iframe) + .claims-annotation-panel (280px collapsible right panel). Panel has: annotation list (cards with edit/promote/delete), global feedback textarea, send-to-worker footer. Panel starts collapsed, auto-expands on first annotation save.

    Annotation input is a fixed-position popover that floats above the highlight/pin inside the iframe (not inline document flow). Caret arrow points toward anchor, flips below if insufficient room, horizontal clamping. Enter saves, Shift+Enter for newline.

    Image annotation gated behind fullscreen lightbox — inline images capped at 50vh + max-width:100%, cursor:zoom-in. Click opens dark fullscreen overlay where crosshair clicking places pins + annotation popover. Existing pins render in lightbox. Lightbox closes on save (via renderVisualMarkers) or Esc/backdrop click.

    Font size reduced 30% on claim content via injected CSS (font-size: 0.7em on [data-claim-id], #claim-panel).

    Files: ClaimsDashboard.ts (~580 LOC, uses AnnotationPanel generic), claims-annotate.js (~500 LOC, down from 730 original), index.html CSS additions. PostMessage protocol: iframe sends claims-annotation-save + claims-annotation-load; parent sends claims-annotation-loaded. Removed: claims-annotation-selection, claims-annotation-cancel, claims-annotation-send, claims-annotation-delete, claims-annotation-promote (all handled parent-side now).
---
