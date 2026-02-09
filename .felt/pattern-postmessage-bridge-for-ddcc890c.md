---
title: 'Pattern: postMessage bridge for iframe interaction'
status: closed
kind: spec
priority: 2
created-at: 2026-02-07T03:09:39.975002+01:00
closed-at: 2026-02-07T03:09:39.975009+01:00
close-reason: When portolan proxies external HTML in an iframe (claims dashboard, playgrounds), interaction features are injected via script tag during proxy rewriting. Injected script communicates with portolan parent via postMessage. Parent listens, routes to existing endpoints. Iframe content stays standalone-compatible — injected script is a no-op without a parent listener. Implemented for claims-annotate.js; pattern applies to any future iframe interaction.
---
