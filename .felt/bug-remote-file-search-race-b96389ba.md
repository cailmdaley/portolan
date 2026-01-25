---
title: 'Bug: Remote file search race condition killed filename results'
status: closed
kind: decision
priority: 2
depends-on:
    - search-tools-fd-rg-with-find-ee13e331
created-at: 2026-01-25T15:21:53.824228+01:00
closed-at: 2026-01-25T15:21:53.824233+01:00
close-reason: |-
    Problem: Frontend sends filename + content searches simultaneously. Server was canceling ALL searches for a city when new search arrived, so content search killed filename search before it returned.

    Fix: Changed server cancellation logic (index.ts:601-608) to only cancel searches from previous search sessions, not parallel searches from same session. Extract searchBase from searchId and only cancel if different base.

    Also disabled content search for remote cities entirely (CityPanel.ts) - too slow over SSH for large codebases.
---
