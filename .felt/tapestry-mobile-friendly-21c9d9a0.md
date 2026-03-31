---
title: Tapestry mobile-friendly
status: closed
tags:
    - portolan
created-at: 2026-03-22T09:07:27.540115+01:00
closed-at: 2026-03-29T22:59:47.056343+02:00
outcome: 'Collapsed sidebar: search pill on desktop (bottom-right), full-width bar on mobile. Search results float as dropdown. Mobile detail is full-screen overlay with ← Back. Tables fixed with table-layout:fixed + word-break. Downstream filtered to DAG nodes only. CSS in both index.html (desktop collapsed) and src/static/index.html (+ mobile @media). JS: TapestrySidebar.collapse()/expand(), TapestryView orchestrates state transitions.'
---

Redesign tapestry sidebar for mobile: (1) Default state shows collapsed search pill (desktop: bottom-right floating, mobile: full-width bottom bar), not the full fiber list. (2) Mobile detail panel is full-screen overlay with back button. (3) Mobile changes target static site only; desktop sidebar collapse applies to both eventually.

## Comments
**2026-03-22 09:17** — CSS + JS changes in place. Collapsed sidebar: pill on desktop, bar on mobile. Search results float as dropdown. Mobile detail is full-screen overlay. Tests pass, static build clean.
