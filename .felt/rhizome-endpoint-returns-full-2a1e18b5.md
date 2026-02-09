---
title: Rhizome endpoint returns full DAG in single call
status: closed
kind: decision
priority: 2
depends-on:
    - absorb-claims-dashboard-into-ed04e0e9
created-at: 2026-02-09T02:14:48.109451+01:00
closed-at: 2026-02-09T02:14:48.140269+01:00
close-reason: 'GET /rhizome?cityId= returns {nodes, links, downstream}. Nodes: fibers with rule: tags including body text, evidence metrics/artifacts/mtime, staleness flags. Links: dependency edges (filtered to only rule-fiber references). Downstream: non-rule fibers that depend on rule fibers (tasks, questions, etc). Staleness: ''fresh'' (evidence mtime >= all upstream), ''stale'' (older than upstream), ''no-evidence''. Single fiber read partitioned in memory. Evidence read in parallel. Remote cities use felt ls --json --body via SSH.'
---
