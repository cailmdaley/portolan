---
title: Fiber anatomy
status: open
tags:
    - tapestry:portolan
depends-on:
    - tapestry-structure-4401c64b
created-at: 2026-02-21T17:18:16.085368+01:00
outcome: 'A fiber has: title (short name), body (markdown content), outcome (conclusion), kind (task/decision/question/spec), status (open/active/closed), tags, depends_on edges, and timestamps.'
---

A fiber has six essential fields. **Title**: a short name (2-5 words). **Body**: markdown content — the working space. Write the investigation here: what you tried, what you found, relevant code or references. **Outcome**: the conclusion. Not 'I closed this' but 'X because Y.' **Kind**: task, decision, question, or spec — what type of concern this is. **Status**: open, active, or closed. **Tags**: freeform labels plus two special prefixes — `tapestry:` to include in a named tapestry view, and `tier:1` to mark as a section node.

The body and outcome serve different purposes. The body is the working document — it can be rough, exploratory, updated as the investigation develops. The outcome is the final word — a sentence or two written when you close the fiber, capturing the conclusion so the next reader doesn't have to reconstruct it. Think of outcomes as the labels on a filing cabinet: the body is the folder contents, the outcome is what's written on the tab.

Fibers are created with `felt add "Title" -t tag -a <upstream-id>`. Edit title, status, outcome, and body with `felt edit <id>`. Closing a fiber requires writing an outcome: `felt edit <id> -s closed -o "outcome text"`. Every fiber starts as a plain markdown file in `.felt/` — readable and editable without any tooling, version-controlled alongside the project.
