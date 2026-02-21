---
title: Unified upstream/downstream display in RhizomeView detail panel
status: closed
kind: decision
priority: 2
depends-on:
    - absorb-claims-dashboard-into-ed04e0e9
created-at: 2026-02-09T11:07:49.071118+01:00
closed-at: 2026-02-09T11:07:49.100487+01:00
close-reason: 'Replaced ''Depends on:'' dep-tags at top + collapsible ''Downstream'' section at bottom with unified graph block above the plot. Two lines: ''Upstream'' and ''Downstream'', both using dep-tag styling. Downstream tags include status icon (open/active/closed glyph). Both navigate via navigateToFiber(). Deleted ~45 lines of mini-detail popover CSS and downstream section CSS.'
---
