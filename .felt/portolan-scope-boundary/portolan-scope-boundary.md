---
title: Portolan scope boundary
tags:
    - portolan
depends-on:
    - descope-conversation-cards
    - file-tree-browser
created-at: 2026-03-01T16:30:47.301691+01:00
outcome: |-
    Navigation + inspection + incidental editing. The rule: if you can get the same thing by clicking the worker and being in terminal in <2 seconds, don't build it into Portolan. Build things you can't get from the terminal — spatial overview, cross-project status, the DAG.

    What's clearly in scope: spatial map, fiber status, tapestry, file viewer/browser, git status display, worker spawning, search.

    What's borderline: conversation cards (only value is seeing recent file reads/edits — descoped in descope-conversation-cards-6462df9c), file editing (low usage but low maintenance cost, keep).

    What's out: reply-from-card, integrated terminal, LSP, multi-tab editing, git diff viewer.

    Annotations are in scope — the selection→highlight→send workflow is genuinely faster than describing locations in text. Not competing with the terminal; augmenting it.
---

(portolan-scope-boundary)=
# Portolan scope boundary
