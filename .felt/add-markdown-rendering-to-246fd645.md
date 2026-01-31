---
title: Add markdown rendering to conversation messages
status: closed
kind: task
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T03:46:03.484839+01:00
closed-at: 2026-01-31T03:53:40.673852+01:00
close-reason: |-
    Implemented markdown rendering + parchment aesthetic redesign:

    1. Added renderMarkdown() utility using marked library with Prism.js syntax highlighting
    2. Updated WorkerActivityPanel to render user/assistant messages as markdown (expanded state)
    3. Redesigned both panels with Renaissance parchment aesthetic:
       - Warm paper grain texture via SVG filters
       - Foxing (age spots) via radial gradients
       - Sun-touched warm gradients (#F8F2E8 to #E3D7C4)
       - Brass gilding trim on top
       - Soft edge vignettes
    4. Updated message bubbles, badges, thinking blocks, tool items for light theme
    5. Added markdown content styles: code blocks, inline code, blockquotes, links, lists

    Palette shift: Dark UI (#1A1816) → Parchment Afternoon (#E8E0D4). Warm, organic, Renaissance cartography feel.
---
