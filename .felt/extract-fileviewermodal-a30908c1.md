---
title: Extract FileViewerModal markdown view
status: closed
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-10T18:52:33.868486+01:00
closed-at: 2026-03-10T18:56:23.097633+01:00
outcome: Extracted FileViewerModal's rendered-markdown and fiber-card subsystem into src/ui/FileViewerMarkdownView.ts so the modal now delegates markdown DOM creation, frontmatter parsing, fiber header rendering, inline path navigation, rendered selection handling, and cancelable tapestry context hydration. FileViewerModal.ts dropped to 1111 LOC. Verified with npm run build.
---
