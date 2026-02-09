---
title: 'Claims annotation panel: show only when annotations exist'
status: closed
kind: decision
priority: 2
depends-on:
    - claims-annotation-inline-bba0fc30
created-at: 2026-02-07T21:11:32.278127+01:00
closed-at: 2026-02-07T21:11:32.278131+01:00
close-reason: Annotation side panel starts hidden (display:none via .hidden class). Only revealed when handleAnnotationLoad returns annotations.length > 0. Auto-hides when switching to a claim with no annotations. Previously it was always visible (just collapsed to 40px). This avoids the empty panel clutter and × button overlap.
---
