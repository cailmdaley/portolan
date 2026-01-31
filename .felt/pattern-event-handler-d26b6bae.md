---
title: 'Pattern: Event handler registration order matters for stopImmediatePropagation'
status: closed
kind: spec
priority: 2
depends-on:
    - pattern-vite-hmr-stacks-f3ed5ac0
created-at: 2026-01-27T03:07:18.113218+01:00
closed-at: 2026-01-27T03:07:18.113222+01:00
close-reason: |-
    When multiple components register document-level event handlers, `stopImmediatePropagation()` only prevents handlers registered AFTER the current handler from firing.

    **Implication:** If ComponentA registers before ComponentB, ComponentA's handler fires first. ComponentB calling stopImmediatePropagation won't prevent ComponentA.

    **Solution patterns:**
    1. Have earlier handlers check for modal/overlay visibility before acting
    2. Use capture phase (`{ capture: true }`) for priority handlers
    3. Use a single event coordinator instead of distributed handlers

    **Hexarchy example:** FileViewerModal created after CityPanel/WorkerActivityPanel (main.ts:87,90,93), so panels must check for file viewer visibility rather than relying on file viewer to stop propagation.
---
