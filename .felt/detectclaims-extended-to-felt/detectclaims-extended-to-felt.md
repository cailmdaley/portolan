---
title: detectClaims extended to .felt/ dirs
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered
created-at: 2026-02-21T18:50:32.10415+01:00
outcome: CityManager.detectClaims() previously required workflow/config or results/claims dirs. Extended to also return true when .felt/ exists. This makes the tapestry button (⚖) appear for any city with felt fibers, not just those with a claims pipeline.
---

(detectclaims-extended-to-felt)=
# detectClaims extended to .felt/ dirs
