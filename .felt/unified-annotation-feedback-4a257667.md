---
title: 'Unified annotation feedback: removed duplicate send buttons, added line refs to claims'
tags:
    - '[portolan]'
depends-on:
    - claims-annotation-side-panel-f290eeb2
    - absorb-claims-dashboard-into-ed04e0e9
created-at: 2026-02-14T02:46:19.644272+01:00
outcome: 'Removed standalone Save button from RhizomeView global feedback textarea — content now flows as globalComment when sending to worker. Removed duplicate ''Send N annotations to worker'' footer button from both RhizomeView and FileViewerModal (added hideFooter option to AnnotationPanel). Header ''Send to Worker'' button is the single send mechanism. Claims annotations now carry line/endLine/filePath; formatClaimsAnnotationsForClaude includes .felt/ path and (L12-15) refs. Fixed /file-as-fiber: -k (removed flag) → -t (tags).'
---
