---
title: 'Pattern: visibleNodes Set guards opacity overrides in tapestry'
status: closed
tags:
    - portolan
created-at: 2026-02-21T23:10:04.031234+01:00
outcome: 'updateHighlighting() and hideDetail() both set opacity on ALL .tapestry-node elements, overriding the fog opacity (0.07) set by updateTierVisibility(). Fix: check visibleNodes.has(d.data.id) in both functions before modifying opacity — skip fog nodes. visibleNodes is a class field updated by updateTierVisibility() whenever the visible set changes. Must also clear visibleNodes when expandedNodes is cleared (background click, show()).'
---

(pattern-visiblenodes-set-guards)=
# Pattern: visibleNodes Set guards opacity overrides in tapestry
