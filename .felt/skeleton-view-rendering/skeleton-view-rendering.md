---
title: Skeleton view rendering
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered
    - test-tapestry-portolan-self
created-at: 2026-02-21T18:50:22.909097+01:00
outcome: 'Implemented in TapestryView.ts. expandedSections: Set<string> tracks open sections. isSectionNode() checks tier:1 tag. updateTierVisibility() shows/hides nodes/edges via SVG display. Section nodes render 1.5× larger. Click section toggles expansion; click SVG background collapses all. Initial visibility set after burn-in.'
---

(skeleton-view-rendering)=
# Skeleton view rendering
