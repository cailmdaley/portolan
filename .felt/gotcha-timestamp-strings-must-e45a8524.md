---
title: 'Gotcha: timestamp strings must remain ISO 8601 parseable'
status: closed
kind: spec
priority: 2
depends-on:
    - portolan-polish-reliability-7a523ad7
created-at: 2026-02-04T05:29:44.135077+01:00
closed-at: 2026-02-04T05:29:44.135079+01:00
close-reason: Hook script fixed to use base timestamp. formatTimeAgo() now returns empty string for NaN/invalid timestamps as defensive measure.
---

Deduplication schemes that append suffixes to timestamps (e.g., adding .idx for uniqueness) break Date.parse(). The portolan conversation hook was doing this, causing Invalid Date display in the UI.

Solution: Use content-based deduplication instead, or append unique suffixes to a separate field.
