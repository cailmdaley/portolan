---
title: Detail panel
tags:
    - tapestry:portolan
depends-on:
    - tapestry-interaction-74c5f450
created-at: 2026-02-21T19:11:46.121648+01:00
outcome: Selecting a node opens a resizable sidebar showing outcome, rendered markdown body, evidence metrics, artifact gallery, upstream/downstream tags, and kind/status metadata.
---

Selecting any node (by clicking it) opens the detail panel — a resizable sidebar on the right side of the tapestry view. The panel shows the fiber's full content: a staleness badge and title in the header, status/kind/dates in the meta row, then a scrollable content area containing the dependency graph (upstream ← and downstream → tags), outcome, artifact gallery, rendered markdown body, and evidence metrics.

The body is rendered as HTML via `renderMarkdown()` with syntax highlighting applied by `highlightCodeBlocks()` after insertion. Config interpolation replaces `{{key}}` placeholders with values from `workflow/config/config.yaml`. Inline file paths become clickable links. Evidence metrics are flattened — nested objects like `{chi2: {value: 1.2}}` display as `chi2.value: 1.2000`. Artifact images appear in a gallery grid with lightbox expansion.

The panel is resizable via a left-edge drag handle, constrained between 280px and 800px (default 420px). Upstream and downstream fiber names appear as clickable tags that navigate to that node. The body supports double-click-to-edit via CodeMirror with vim keybindings, persisting changes directly to the `.felt/` file. A refresh button re-fetches tapestry data from the server to pick up external changes.
