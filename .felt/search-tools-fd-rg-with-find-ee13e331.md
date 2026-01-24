---
title: 'Search tools: fd/rg with find/grep fallback'
status: closed
kind: decision
priority: 2
depends-on:
    - file-search-in-citypanel-24a5dd1b
created-at: 2026-01-21T22:13:17.573315+01:00
closed-at: 2026-01-21T22:13:26.564949+01:00
close-reason: |-
    Use fd for filename search, rg for content search. Both are fast and respect .gitignore.

    Fallback to find+grep when tools aren't installed (common on remote machines). Server checks tool availability on startup via 'which', caches result.

    Remote search tries fd/rg first in subshell, falls back inline: (fd ... || find ... | grep ...) | head -50

    Installed locally via: brew install fd ripgrep
---
