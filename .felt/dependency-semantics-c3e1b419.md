---
title: Dependency semantics
status: open
tags:
    - tapestry:portolan
depends-on:
    - tapestry-structure-4401c64b
created-at: 2026-02-21T17:18:22.13298+01:00
outcome: 'An edge A→B means B depends on A. If A changes, B may need updating. Staleness propagates downstream: a stale parent makes children stale. The DAG encodes both causal order and update sensitivity.'
---
