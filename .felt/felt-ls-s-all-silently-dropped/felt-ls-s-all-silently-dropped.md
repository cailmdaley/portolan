---
title: felt ls -s all silently dropped statusless fibers
tags:
    - decision
created-at: 2026-02-12T00:22:46.615616+01:00
outcome: 'felt ls had --all and -s all doing different things. Dropped --all; -s all now includes everything. ls absorbed find (query arg, -e, -r). Tag prefix matching: -t rule: matches rule:*. Fixed 27/29 invisible rule-tagged fibers in pure_eb dashboard.'
---

(felt-ls-s-all-silently-dropped)=
# felt ls -s all silently dropped statusless fibers
