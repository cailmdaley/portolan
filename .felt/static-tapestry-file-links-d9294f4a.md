---
title: 'Static tapestry file links: three-layer fix'
status: closed
tags:
    - portolan
depends-on:
    - static-rhizome-dashboard-on-13a8fbc4
created-at: 2026-02-18T02:37:13.036599+01:00
outcome: 'File links in static tapestry (GitHub Pages) were broken at three levels: (1) export script wrote absolute paths (/tapestries/data/...) but TapestryView prepended ./data/ causing double-path URLs — fixed by using relative paths in export. (2) Link click handler was only on .tapestry-detail-body, missing links in outcome section — moved handler to .tapestry-detail-content. (3) ./data/ relative resolution breaks under SPA path routing — switched to absolute staticDataBase derived from assetBase. (4) Export only rewrote body links, not outcome or sidebar fiber links — now rewrites all text fields across nodes and fibers.'
---
