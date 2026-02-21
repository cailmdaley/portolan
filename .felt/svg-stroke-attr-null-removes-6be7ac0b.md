---
title: SVG stroke attr null removes color
status: closed
tags:
    - portolan
created-at: 2026-02-21T20:30:14.776785+01:00
outcome: 'Setting .attr(''stroke'', null) in D3 removes the attribute entirely. In SVG, elements with no stroke attribute default to none — edges become invisible. Fix: always pass a color value. In updateHighlighting(), use stalenessColor(d.link.target.data.staleness) for non-warp edges. In hideDetail(), restore each edge''s staleness color via .each(). Never use null as a ''restore to original'' value for SVG attributes.'
---
