---
title: 'Tapestry detail panel: in-place artifact swap instead of full rebuild'
status: closed
tags:
    - portolan
depends-on:
    - array-artifact-values-crash
created-at: 2026-02-18T02:37:05.161316+01:00
outcome: renderDetailPanel() was called on every artifact arrow click, arrow key press, and lightbox close — destroying in-flight image loads and re-triggering markdown rendering + code highlighting. Added updateArtifact() that swaps img.src and label text in-place. Also preloads first artifact of upstream/downstream neighbors on node selection. Arrow key handler was stacking (never removed between node selections) causing random jumps — fixed by removing old handler at start of bindDetailEvents.
---

(tapestry-detail-panel-in-place)=
# Tapestry detail panel: in-place artifact swap instead of full rebuild
