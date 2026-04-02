---
title: Extracted Kitty session control from KittyIntegration
tags:
    - '[portolan]'
depends-on:
    - simplification-sweep
created-at: 2026-03-11T21:56:28.257505+01:00
outcome: Split tmux tab focus and worker termination into KittySessionController so KittyIntegration now coordinates worker creation and handoff without owning local/remote session-tab control. Added unit tests for local focus fallback, remote attach launch, and remote kill command construction after verifying with cd server && npm test and npm run build.
---

(extracted-kitty-session-control)=
# Extracted Kitty session control from KittyIntegration
