---
title: Unify HUD search across tabs
depends-on:
    - implement-nested-symlink
    - implement-city-sidebar-lazy
    - unify-citypanel-single-search
created-at: 2026-03-04T21:25:46.877177+01:00
outcome: 'File search (fd) and fiber search were entangled in CityHUD. File search only worked on Fibers tab because: (1) search results <ul> was inside hud-pane-fibers, hidden on Files tab — moved to hud-content level. (2) handleSearchResults guarded on activeTab===''fibers'' — removed tab restriction. (3) Input handler on Files tab only filtered the tree locally, never fired fd search — unified performSearch for both tabs. Now: Fibers tab = instant local fiber filter on input. Files tab = fd filename search on Enter. .felt/ excluded from file search. Content search (rg) removed from file search — was returning noise.'
---

(unify-hud-search-across-tabs)=
# Unify HUD search across tabs
