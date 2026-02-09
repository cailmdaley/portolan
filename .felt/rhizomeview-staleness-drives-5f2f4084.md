---
title: 'RhizomeView: staleness drives node/edge color (replaces kind-based coloring)'
status: closed
kind: decision
priority: 2
depends-on:
    - absorb-claims-dashboard-into-ed04e0e9
created-at: 2026-02-09T02:32:45.505325+01:00
closed-at: 2026-02-09T02:32:45.53835+01:00
close-reason: 'Reference dashboard used foundation/claim/synthesis kind taxonomy for node colors. RhizomeView uses staleness as the primary color signal: teal (#5A7B7B) for fresh, red (#A87070) for stale, gray (#7A7368) for unknown. This makes the most actionable information visible at a glance — what needs regeneration.'
---
