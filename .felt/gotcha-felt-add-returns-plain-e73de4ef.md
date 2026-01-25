---
title: 'Gotcha: felt add returns plain text ID, not JSON'
status: closed
kind: spec
priority: 2
depends-on:
    - feature-file-as-fiber-button-in-fccaddd6
created-at: 2026-01-25T15:22:18.208426+01:00
closed-at: 2026-01-25T15:22:18.208433+01:00
close-reason: |-
    felt add --json does NOT return JSON. It just returns the fiber ID as plain text:

    $ felt add 'Test' -k task --json
    test-fiber-46dd5eb3

    Server code was trying to JSON.parse() and failing. Fix: just use stdout.trim() directly as the fiber ID.
---
