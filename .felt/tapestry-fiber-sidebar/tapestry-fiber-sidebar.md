---
title: 'Tapestry fiber sidebar: persistent fiber list with expanding detail panel'
status: closed
tags:
    - '[portolan]'
depends-on:
    - absorb-claims-dashboard-into
created-at: 2026-02-14T16:53:56.850443+01:00
outcome: Added a right sidebar to the tapestry view (RhizomeView) showing all city fibers. Default 20vw width shows a searchable fiber list with unified status/staleness dots, non-rule tag badges, and a legend. Clicking any fiber expands sidebar to 40vw (draggable 300-800px) and shows the detail panel. Escape collapses back. Server endpoint now returns all fibers alongside DAG nodes. Works in both live and static modes.
---

(tapestry-fiber-sidebar)=
# Tapestry fiber sidebar: persistent fiber list with expanding detail panel
