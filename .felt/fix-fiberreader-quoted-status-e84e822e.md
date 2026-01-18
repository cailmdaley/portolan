---
title: Fix FiberReader quoted status handling
status: closed
kind: task
tags:
    - ralph:4
priority: 2
depends-on:
    - server-14a1cdf1
created-at: 2026-01-18T02:01:46.120443+01:00
closed-at: 2026-01-18T02:02:35.029825+01:00
close-reason: 'Fixed parseFrontmatterStatus to strip surrounding quotes (both single and double) from status values using regex /^["'']|["'']$/g. Added test case for status: "closed" to verify it''s correctly counted as closed (0 open fibers) rather than open. All 58 tests pass, build succeeds.'
---
