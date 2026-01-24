---
title: 'Pattern: Inline edit form in list items'
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T01:08:54.081867+01:00
closed-at: 2026-01-24T01:08:54.081872+01:00
close-reason: 'When adding edit functionality to list item UIs, replace content div with inline form (textarea + Save/Cancel buttons) rather than modal. Pattern: click edit → replace .annotation-comment innerHTML with form → Enter saves, Escape cancels → re-render list on success. Keeps context visible, reduces modal fatigue.'
---
