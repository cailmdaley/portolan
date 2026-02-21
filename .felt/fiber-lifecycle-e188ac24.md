---
title: Fiber lifecycle
tags:
    - tapestry:portolan
depends-on:
    - tapestry-introduction-537a6234
created-at: 2026-02-21T19:11:13.976075+01:00
outcome: Fibers progress open→active→closed. Outcomes record what was decided and why, linking back through the DAG to explain the reasoning chain.
---

Every fiber begins with status `open` — a concern has been identified but work hasn't started. When someone picks it up, it moves to `active`, signaling that investigation is underway. Closing a fiber requires writing an outcome: a sentence or two explaining what was decided, what was found, or why the concern was resolved.

The outcome is the most important part of a fiber. It's not just a status flag — it's the record of *why* the decision was made. When a downstream fiber needs context, walking the DAG to read upstream outcomes should reconstruct the full reasoning chain without digging through transcripts or chat logs.

`FiberReader.parseFiber()` extracts status from YAML frontmatter, defaulting to `open` if absent. The `getOpenFibers()` function sorts active fibers before open ones, then by priority. Recently closed fibers are available via `getRecentlyClosed()`, sorted by `closedAt` timestamp. The sidebar displays fibers grouped by this same ordering — active work surfaces first.
