---
title: Extract TapestryView data runtime
status: closed
created-at: 2026-03-11T18:21:24.263087+01:00
closed-at: 2026-03-11T18:25:15.564486+01:00
outcome: Extracted TapestryView's data runtime into src/ui/TapestryViewRuntime.ts so fetch request ownership, URL/hash synchronization, static export state, static file modal ownership, and artifact preloading no longer live inside the main coordinator. Verified with npm run build and cd server && npm test.
---

(extract-tapestryview-data)=
# Extract TapestryView data runtime
