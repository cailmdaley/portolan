---
title: URL fragments
status: open
tags:
    - tapestry:portolan
depends-on:
    - tapestry-interaction-74c5f450
created-at: 2026-02-21T17:18:46.591354+01:00
outcome: 'Clicking a node pushes #fiber-id to the URL. Opening a URL with a hash auto-selects that node. Works for both DAG nodes and sidebar fibers. Enables shareable deep links into specific parts of the analysis.'
---

Clicking any node writes `#fiber-id` to the URL using `history.pushState`. The URL becomes a deep link into the tapestry: opening it auto-expands the containing section and selects the node. Deselecting a node clears the hash with `replaceState` — a reset, not a forward navigation step, so the back button doesn't have to undo deselections.

This works in both the live tapestry and the static export. The static export is a self-contained directory that deploys to any static host (GitHub Pages, Netlify, S3). Every fiber in a published tapestry is directly linkable — share the URL for a specific finding, a key decision, the vocabulary node. The recipient arrives at the same view you're looking at, fog and all.

URL navigation is how the tapestry becomes a medium for communication, not just a personal navigation tool. The warp trace you see when you open a shared link is the same gold thread the sender saw — the path back to the section, showing exactly where in the argument structure this node lives.
