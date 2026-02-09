---
title: 'rule: tag replaces spec: tag for rhizome fibers'
status: closed
kind: decision
priority: 2
depends-on:
    - absorb-claims-dashboard-into-ed04e0e9
created-at: 2026-02-09T02:14:53.228007+01:00
closed-at: 2026-02-09T02:14:53.260842+01:00
close-reason: 'The loom conducting-research system uses spec:<name> tags to map fibers to results/claims/<name>/. The portolan rhizome spec mandates rule:<name> instead. getSpecName() extracts from rule: prefix. Evidence directory mapping: rule:cosebis_data_vector → results/claims/cosebis_data_vector/evidence.json. No real rule:-tagged fibers exist yet in any project — the data layer is ready but needs fibers to be created with the new convention.'
---
