---
title: 'Pattern: Safari ignores pointer-events:none on iframes'
status: closed
kind: doc
priority: 2
created-at: 2026-01-31T04:53:36.83075+01:00
closed-at: 2026-01-31T04:53:47.788028+01:00
close-reason: 'Safari ignores pointer-events:none on iframes. Even when parent has pointer-events:none and opacity:0, the iframe still captures mouse/touch events and blocks scrolling on elements beneath it. Fix: use display:none on iframes when their container is hidden, then display:block when .visible class is added.'
---


## Comments
**2026-01-31 04:54** — This also caused right-click context menus to fail in Safari - the iframe was capturing all pointer events including contextmenu.

