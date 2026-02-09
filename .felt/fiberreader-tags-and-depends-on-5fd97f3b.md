---
title: 'FiberReader: tags and depends-on parsed from YAML list frontmatter'
status: closed
kind: decision
priority: 2
depends-on:
    - absorb-claims-dashboard-into-ed04e0e9
created-at: 2026-02-09T02:14:44.603799+01:00
closed-at: 2026-02-09T02:14:44.63752+01:00
close-reason: 'Extended parseFiber with getListField() to handle YAML list syntax (indented ''- item'' lines after field header). Fixed field name mapping: felt uses ''created-at'', ''closed-at'', ''close-reason'' (hyphenated) not ''created'', ''closed'', ''reason''. Previous parser never matched these correctly — was a pre-existing bug but didn''t affect HUD (only uses title/status/kind/priority). Tags stored as string array, dependsOn as string array. Export parseFiber for direct testing.'
---
