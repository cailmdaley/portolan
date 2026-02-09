---
title: 'Pattern: auto-bridge injected scripts to host globals'
status: closed
kind: spec
priority: 2
depends-on:
    - claims-annotation-inline-bba0fc30
created-at: 2026-02-07T04:30:20.976473+01:00
closed-at: 2026-02-07T04:30:21.004865+01:00
close-reason: 'When portolan injects a script into a proxied iframe (claims-annotate.js), the script can''t rely on the host page having specific data attributes. Instead, read host globals (currentClaimId, claimGraph) and inject data attributes via MutationObserver. Three-layer fallback: (1) explicit data-* attributes, (2) DOM containment + globals, (3) derive from element attributes (src → filename). This eliminates coupling to the consumer template — the research skill doesn''t need to know about portolan annotations.'
---
