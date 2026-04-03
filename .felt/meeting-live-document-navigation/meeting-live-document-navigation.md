---
title: Meeting live document navigation
status: closed
tags:
    - task
created-at: 2026-04-03T03:28:11.642631+02:00
closed-at: 2026-04-03T03:28:16.714838+02:00
outcome: 'The Portolan meeting live brief now behaves like a real document surface instead of a dead markdown summary. MeetingBridge emits markdown file links for retrieved evidence, promoted fibers, and per-run provenance logs; the markdown viewers intercept file-path links and open them inside Portolan rather than spawning external navigation. Evidence: npm --prefix server exec vitest run src/__tests__/MeetingBridge.test.ts; npm --prefix server run build; npm run build.'
---

(meeting-live-document-navigation)=
Make the generated Portolan meeting live brief a navigable document surface rather than a markdown summary with dead provenance paths. The live brief should emit markdown file links for evidence, promoted fibers, and logs, and the markdown viewers should open those links inside Portolan for local file navigation.
