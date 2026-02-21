---
title: RhizomeView links navigate in-view instead of opening new tabs
status: closed
kind: decision
priority: 2
depends-on:
    - absorb-claims-dashboard-into-ed04e0e9
created-at: 2026-02-09T11:07:41.756411+01:00
closed-at: 2026-02-09T11:07:41.782598+01:00
close-reason: 'Three link types unified under navigateToFiber(): dep-tags, downstream items, and body markdown links. Rule fibers navigate within the DAG via selectNode(). Non-rule fibers and file paths open in FileViewerModal via setOnOpenFile callback. External URLs still open in browser. Deleted showMiniFiberDetail popover.'
---
