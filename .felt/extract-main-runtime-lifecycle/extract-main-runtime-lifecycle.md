---
title: Extract main runtime lifecycle
status: closed
tags:
    - task
created-at: 2026-03-11T17:53:15.471986+01:00
closed-at: 2026-03-11T17:56:16.244329+01:00
outcome: Extracted resize/render/cleanup/mock fallback runtime from src/main.ts into src/runtime/FrontendAppRuntime.ts. main.ts now coordinates scene wiring, state sync, and map interactions. Verified with npm run build and cd server && npm test.
---

(extract-main-runtime-lifecycle)=
# Extract main runtime lifecycle
