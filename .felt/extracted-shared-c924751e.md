---
title: Extracted shared AnnotationPanel<T> component
status: closed
kind: task
priority: 2
depends-on:
    - claims-annotation-inline-bba0fc30
    - bug-annotation-panel-collapse-d5e20f90
created-at: 2026-02-07T21:11:39.952806+01:00
closed-at: 2026-02-07T21:11:39.95281+01:00
close-reason: 'Annotation side panels in ClaimsDashboard and FileViewerModal were ~150-180 lines of duplicate code each (list rendering, inline edit, delete, clear all, send to worker). Extracted into AnnotationPanel<T> (415 lines) in src/ui/AnnotationPanel.ts. Generic over annotation type, consumer-specific behavior via callbacks: onGoto (FileViewerModal), onPromote (ClaimsDashboard), renderPreview. Also fixed a bug: ClaimsDashboard was using PATCH for annotation updates but server only accepts PUT.'
---
