---
title: Tapestry tags
depends-on:
    - fibers
created-at: 2026-02-21T19:11:27.171943+01:00
outcome: 'The tapestry: tag prefix selects fibers into a named tapestry. The tier:1 tag marks section nodes — large, always-visible anchors that organize the skeleton view.'
---

(tapestry-tags)=
Fibers enter a tapestry through their tags. The server's `handleTapestry()` endpoint filters all city fibers for those with tags starting with `tapestry:` (or the legacy `rule:` prefix). The portion after the colon is the spec name — e.g., `tapestry:portolan` places the fiber in the portolan tapestry, and `portolan` becomes the spec name used to locate evidence at `results/claims/portolan/evidence.json`.

The `tier:1` tag marks a fiber as a section node. Section nodes are rendered at 1.5x scale, always visible in the skeleton view, and have their X position pinned after burn-in. They carry a dot strip at the bottom showing their interior (non-section) neighbors, colored by staleness. A tapestry with no `tier:1` nodes renders as a flat graph; adding them activates the two-tier pyramid navigation.

Tag normalization handles a subtle bug: YAML list items like `"claim, tapestry:foo"` are a single string, not two tags. Both `FiberReader.parseFiber()` and `HttpApi.getAllCityFibers()` split comma-separated values within a single tag entry, ensuring `tapestry:` filtering doesn't silently miss fibers. This was a recurring source of invisible data loss before the fix.
