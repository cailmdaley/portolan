---
title: Hash navigation
tags:
    - tapestry:portolan
depends-on:
    - url-fragments-4fe425f3
created-at: 2026-02-21T19:27:15.602931+01:00
outcome: selectFromHash() runs on show, checking window.location.hash against both DAG nodes and sidebar fibers. pushHash() uses history.pushState for forward nav and replaceState to clear. Enables shareable deep links into specific fiber views.
---

Hash navigation bridges URL state and tapestry selection. Two methods manage the hash: `pushHash(id)` writes a fiber ID to the URL fragment, and `selectFromHash()` reads the current fragment and selects the corresponding node or fiber. Together they enable shareable deep links — opening `tapestry.html#staleness-computation-ae36c717` auto-selects that fiber on load.

`pushHash()` uses `history.pushState` to set the hash without triggering a page reload. It guards against redundant updates by comparing the new ID against the current `window.location.hash.slice(1)`. To clear the hash (when deselecting), it calls `replaceState` with just the pathname and search — this avoids cluttering the browser history with empty-hash entries, since deselection is a navigation reset, not a forward step.

`selectFromHash()` runs at the end of `show()`, after both the DAG and fiber list have rendered. It first searches DAG nodes (by `id` match), falling back to sidebar fibers if no DAG node matches. This two-tier lookup matters because the sidebar shows all fibers for the city, not just those with `tapestry:` tags in the DAG. A DAG match calls `selectNode()` (opening the detail panel and highlighting), while a fiber match calls `selectFiber()` (scrolling to and highlighting the fiber in the sidebar).

The static tapestry export preserves this behavior — the same hash logic works on GitHub Pages, making every fiber in a published tapestry directly linkable.
