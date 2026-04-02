---
title: Sidebar status glyphs
status: closed
tags:
    - astra
    - mystra
depends-on:
    - astra-document-viewer
created-at: 2026-04-02T05:10:05.298711+02:00
outcome: 'DOM-injecting SidebarStatusInjector component fetches ASTRA graph, builds slug→status map, prepends ✓/○/?/✕ glyphs to myst-toc-item sidebar links. Porch-morning palette colors: teal resolved, taupe open, amber suspicious, mauve blocked. Avoids modifying packages/site by using useEffect DOM injection after each navigation. Committed cc48885b in mystra-theme.'
---

(sidebar-status-glyphs)=
# Sidebar status glyphs
