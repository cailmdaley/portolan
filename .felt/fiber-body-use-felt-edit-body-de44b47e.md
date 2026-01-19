---
title: 'Fiber body: use felt edit --body, not cat >> (breaks YAML frontmatter)'
status: closed
kind: decision
priority: 2
depends-on:
    - global-views-map-plots-plans-3374f8fb
created-at: 2026-01-19T09:14:53.900123+01:00
closed-at: 2026-01-19T09:15:02.797352+01:00
close-reason: 'Felt fibers have YAML frontmatter (---title/status/etc---). Using ''cat plan.md >> fiber.md'' overwrites the frontmatter, breaking the fiber. Instead: ''felt edit <id> --body "$(cat plan.md)"'' preserves structure. Discovered when ralph spec wasn''t loading — felt show returned 6 lines instead of 300+.'
---
