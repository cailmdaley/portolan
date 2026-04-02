---
title: Global search palette
status: closed
created-at: 2026-03-14T13:21:32.151542+01:00
closed-at: 2026-03-14T13:24:48.628357+01:00
outcome: Added a global '/' search palette overlay for cities and workers with Porch Morning styling, client-side substring matching, grouped results, keyboard/mouse selection, and explicit listener cleanup. Wired it into main.ts with a guarded global keydown handler plus city/worker selection callbacks that reuse existing focus, city HUD, and kitty-tab behavior.
---

(global-search-palette-2)=
# Global search palette
