---
title: Recent worker bar
status: closed
tags:
    - portolan
depends-on:
    - bug-remote-lastactivity-inflated-ae8ce2fb
created-at: 2026-03-14T15:45:57.867302+01:00
outcome: 'Perched birds on wire — top-center bar showing 5 most recently active idle workers. Bird sprites tinted verdigris, deterministic rotation from name hash. Opacity cascade (most recent = bold). Diff-based reconciliation: existing birds stay, departures fade out, arrivals land-animate. Hover shows city name + recent files (fetched lazily from /recent-files). File items are clickable — open in FileViewerModal. Fixed remote lastActivity bug: RemoteAgentCoordinator was bumping lastActivity on every poll regardless of status, making remote workers always appear most recent.'
---
