---
title: 'Tapestry label layout: tight line height + smart 2-word split'
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-21T23:21:16.920311+01:00
outcome: 'Two issues: (1) 2-word labels like ''Staleness computation'' were rendered single-line at ~7.6px (too small). Fix: split 2-word labels into two lines when split gives ≥5% larger font. (2) 3-word labels had 1.4× line height (too loose, off-center). Fix: lineHeight=fs*1.1, symmetric baselines at ±lineHeight/2 + ascent offset. NODE_RY 18→21 for more vertical room. Neighbor dots restricted to section nodes only (interior nodes were cluttered). Committed 1509b97.'
---
