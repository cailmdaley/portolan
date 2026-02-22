---
title: 'Centering sidebar-aware: translateTo with visible-area viewport point'
tags:
    - portolan,decision
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T06:06:55.679028+01:00
outcome: 'Node centering on click must account for sidebar width. D3 zoom translateTo accepts optional 4th arg: the viewport point to center on. When sidebar is open: visibleCenterX = (svgWidth - sidebarWidth) / 2. Without this, translateTo centers on the full SVG including the sidebar-occluded area. Fix in TapestryView.ts centerOnNode(); also added 700ms easeCubicInOut animation and fires on every node click (not just search). d3-ease types installed separately.'
---
