---
title: 'Gotcha: let/const globals invisible to window.* in injected scripts'
status: closed
kind: decision
priority: 2
depends-on:
    - claims-annotation-inline-bba0fc30
created-at: 2026-02-07T04:44:31.597692+01:00
closed-at: 2026-02-07T04:44:39.65006+01:00
close-reason: 'Variables declared with let/const at the top level of a <script> tag are NOT properties of window (unlike var). When portolan injects claims-annotate.js into a proxied iframe, it reads window.currentClaimId and window.claimGraph — but the dashboard declares these with let/const, so they''re always undefined. Fix: proxy rewriting promotes `let currentClaimId` → `var currentClaimId` and `const claimGraph` → `var claimGraph` during HTML injection. This is specific to the annotation bridge; other const declarations (imgPath, lightbox, etc.) are left as-is since only targeted variable names are promoted.'
---
