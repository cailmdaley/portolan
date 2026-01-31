---
title: 'Pattern: Hexarchy remote content proxying'
status: closed
kind: spec
priority: 2
depends-on:
    - hexarchy-overview-spatial-map-40356835
created-at: 2026-01-31T01:49:07.803472+01:00
closed-at: 2026-01-31T01:49:07.803473+01:00
close-reason: This pattern enables any content type to work remotely without additional tunnel setup. New endpoint = automatic remote access.
---

Hexarchy already tunnels port 4004 via SSH RemoteForward. Content from remote cities can be served through this tunnel by:
1. Adding HTTP endpoint to HttpApi.ts
2. For local cities: read file directly
3. For remote cities: ssh cat via getSshHost()
4. URL rewriting for assets if needed

Examples: /claims-dashboard, /claims-assets, /playground, /playground-list, /file-content
