---
title: CSS font-size on .tapestry-node-label overrides SVG attribute
tags:
    - portolan
depends-on:
    - css-specificity-gotcha-context-782f26f4
created-at: 2026-02-22T01:56:09.10836+01:00
outcome: 'The CSS rule ''.tapestry-node-label { font-size: 14px }'' in index.html (and src/static/index.html) was overriding the SVG presentation attribute set by .attr(''font-size'', ...) in D3. CSS class selectors beat SVG presentation attributes regardless of specificity. Fix: remove font-size from the CSS rule entirely; let the SVG attribute control it. Both index.html files had the rule.'
---
