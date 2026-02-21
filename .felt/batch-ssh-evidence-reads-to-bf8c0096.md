---
title: Batch SSH evidence reads to avoid connection exhaustion
status: closed
kind: decision
priority: 2
depends-on:
    - rhizome-endpoint-returns-full-2a1e18b5
created-at: 2026-02-09T11:05:15.788458+01:00
closed-at: 2026-02-09T11:05:15.811754+01:00
close-reason: '20 parallel SSH calls for per-spec evidence reads caused half to fail silently (SSH ControlMaster connection limit). Fix: readEvidenceBatch() issues a single SSH command that iterates all specNames, emitting delimited blocks (===SPEC:name=== and ---SEP---). One connection, all data. Result: 20/20 nodes with evidence instead of 10/20. Local cities still use parallel fs reads (no SSH bottleneck).'
---
