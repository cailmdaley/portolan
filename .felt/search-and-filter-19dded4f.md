---
title: Search and filter
tags:
    - tapestry:portolan
depends-on:
    - tapestry-interaction-74c5f450
    - tapestry-tags-0cee7439
    - url-fragments-4fe425f3
created-at: 2026-02-21T19:11:50.430239+01:00
outcome: The search input matches against title, body, kind, and ID. Matching DAG nodes get a highlight class; results appear as a clickable list with staleness-colored dots and context snippets.
---

The tapestry sidebar includes a search input that filters both DAG nodes and the complete fiber list. As the user types, `handleSearch()` concatenates each node's title, body, kind, and ID into a single lowercase string and checks for substring matches. Matching DAG nodes receive a `search-match` CSS class that adds a visual highlight (glow or emphasis) to the SVG node group.

Search results appear as a clickable list below the input, each showing a staleness-colored dot, the node's short name (first 3 words), and a context snippet — 15 characters on either side of the match, with ellipsis truncation. Clicking a result calls `selectNode()`, which opens the detail panel, updates highlighting, and pushes the fiber ID to the URL hash. The search input clears on Escape, and on blur the DAG highlights are removed.

The fiber sidebar list (shown when no node is selected) also respects the search query, filtering the full fiber list — not just DAG nodes — against the same fields plus tags and outcome. Fibers are sorted with tapestry-tagged fibers first (by staleness: stale before no-evidence before fresh), then by status (active, open, untracked, closed), then alphabetically. This layered sorting ensures the fibers most likely needing attention surface first.
