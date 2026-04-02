---
title: 'Pattern: Safari ignores pointer-events:none on iframes'
status: closed
created-at: 2026-01-31T04:53:36.83075+01:00
closed-at: 2026-01-31T04:53:47.788028+01:00
---

(pattern-safari-ignores-pointer)=
## Comments
**2026-01-31 04:54** — This also caused right-click context menus to fail in Safari - the iframe was capturing all pointer events including contextmenu.
