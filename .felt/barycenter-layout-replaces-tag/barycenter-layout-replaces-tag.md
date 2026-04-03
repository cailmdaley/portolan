---
title: Barycenter layout replaces tag-sort
status: closed
tags:
    - astra
    - mystra
    - decision
depends-on:
    - astra-document-viewer
created-at: 2026-04-03T03:38:01.713082+02:00
outcome: 'Replaced tag-sort with Sugiyama barycenter heuristic in AstraMap.tsx layoutNodes. 3 iterations of left→right then right→left passes, each re-sorting a column by avg normalized Y of connected neighbors. Tag sort kept as tie-breaker for stability. Committed 394d196a in mystra-theme. Reason: tag-sort doesn''t consider actual graph structure — nodes with shared sources should sit close vertically; barycenter achieves this naturally.'
---

(barycenter-layout-replaces-tag)=
# Barycenter layout replaces tag-sort
