---
title: 'Decision: annotation panel collapsed by default, expands on first save'
status: closed
kind: decision
priority: 2
depends-on:
    - claims-annotation-side-panel-f290eeb2
created-at: 2026-02-07T21:11:55.770782+01:00
closed-at: 2026-02-07T21:11:55.770786+01:00
close-reason: 'Side panel starts collapsed (width: 40px, shows only toggle button). Auto-expands to 280px on first annotation save (handleAnnotationSave or saveGlobalFeedback calls expandPanel()). Also expands when handleAnnotationLoad finds existing annotations. Rationale: annotation panel is secondary to the claim content — don''t waste screen space until the user is actively annotating. Toggle button (▶/◀) allows manual expand/collapse anytime.'
---
