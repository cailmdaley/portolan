---
title: Investigate remote nested-directory search behavior in Portolan
status: closed
depends-on:
    - implement-city-sidebar-lazy-c7a2200b
    - search-tools-fd-rg-with-find-ee13e331
created-at: 2026-03-02T15:32:08.756693+01:00
closed-at: 2026-03-02T15:32:15.138379+01:00
outcome: Remote filename search uses fd without --full-path, so path-fragment queries (e.g., src/main.ts) return no matches; nested files are discoverable only by basename/content. In Files tab, filtering applies to loaded/visible tree entries only, so unexpanded nested directories are not included.
---
