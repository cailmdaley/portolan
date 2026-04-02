---
title: Implement worker hover file tooltip and remove conversation runtime
status: closed
tags:
    - portolan
depends-on:
    - coastline-file-touch-hover
created-at: 2026-03-02T03:55:47.772795+01:00
closed-at: 2026-03-02T04:04:38.489781+01:00
outcome: Removed conversation-card runtime from frontend and deleted ConversationCard/ConversationCache/CardStatePersistence code paths. ZoneRenderer now owns a 300ms hover tooltip that fetches GET /recent-files on worker hover, shows basename list with full-path inner hover, and emits file clicks to FileViewerModal. Worker click behavior now focuses Kitty (labels + bird hit tests), card lifecycle hooks are gone, conversation CSS removed, and builds/tests pass (root npm run build, server npm test).
---

(implement-worker-hover-file)=
# Implement worker hover file tooltip and remove conversation runtime
