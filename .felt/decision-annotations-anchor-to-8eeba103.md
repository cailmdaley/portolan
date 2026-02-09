---
title: 'Decision: annotations anchor to claim title, not file path'
status: closed
kind: decision
priority: 2
created-at: 2026-02-07T03:09:14.885505+01:00
closed-at: 2026-02-07T03:09:14.885509+01:00
close-reason: 'Claims are compositions of multiple files (fiber .md, plots, evidence.json). File-path anchoring would scatter annotations across files and lose the claim context. Claim title is sufficient for Claude to locate the relevant fiber and evidence. Worker format: ''## [B-modes consistent with zero] > comment''. Simple, human-readable, greppable.'
---
