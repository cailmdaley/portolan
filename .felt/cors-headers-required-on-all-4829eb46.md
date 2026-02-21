---
title: CORS headers required on all rhizome-asset error responses
status: closed
kind: decision
priority: 2
created-at: 2026-02-09T03:07:28.113492+01:00
closed-at: 2026-02-09T03:07:28.113495+01:00
close-reason: During Vite dev (localhost:5173 → localhost:4004), missing Access-Control-Allow-Origin on error responses causes the browser to report CORS failure instead of the actual 400/404. Added the header to all five error paths in handleRhizomeAsset and serveRhizomeAsset. The success path already had it.
---
