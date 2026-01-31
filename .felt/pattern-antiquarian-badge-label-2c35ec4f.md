---
title: 'Pattern: antiquarian badge/label styling'
status: closed
kind: spec
priority: 2
depends-on:
    - hexarchy-visual-design-palette-49cdf63d
created-at: 2026-01-31T05:52:30.120597+01:00
closed-at: 2026-01-31T05:52:30.120602+01:00
close-reason: |-
    To style tech labels (tool badges, status indicators) for an antiquarian/parchment aesthetic:

    1. Use serif font (EB Garamond) instead of monospace
    2. Make text italic — mimics handwritten annotations
    3. Remove solid backgrounds — use transparent or none
    4. Add subtle left border only (like marginal guide lines)
    5. Reduce opacity (0.75-0.8) to make them recede
    6. Use faded sepia/muted colors, not strong contrast

    Goal: Labels should look like pencil notes in margins, not modern UI badges.

    Applied in: #worker-panel .tool-badge, .tool-item
---
