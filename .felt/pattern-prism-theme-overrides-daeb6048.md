---
title: 'Pattern: Prism theme overrides for custom palettes'
status: closed
kind: spec
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T05:46:32.474809+01:00
closed-at: 2026-01-31T05:46:32.474819+01:00
close-reason: "To override prism-tomorrow (or any CDN Prism theme) for custom design palettes:\n\n1. Keep the CDN theme loaded (provides base styling)\n2. Add CSS overrides AFTER the CDN link with higher specificity\n3. Target: `.token.keyword`, `.token.string`, `.token.function`, etc.\n4. Scope overrides to specific containers (e.g., `#worker-panel .md-code-block .token.*`) to preserve different themes elsewhere\n\nToken categories:\n- comment/prolog/doctype/cdata — faded (pencil notes)\n- keyword/atrule/attr-value — emphasis (sepia)\n- string/char/attr-name/selector — quoted (brass/gold)  \n- function/class-name — methodical (verdigris/teal)\n- number/boolean — values (rust/copper)\n- property/constant/symbol/tag — descriptive (brown)\n- operator/entity/url — structural (dark ink)\n\nKey: use colors that complement the container background, not the original theme's assumptions."
---
