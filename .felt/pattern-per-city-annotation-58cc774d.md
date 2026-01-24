---
title: 'Pattern: Per-city annotation filtering with originId'
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T01:03:50.615141+01:00
closed-at: 2026-01-24T01:03:50.615144+01:00
close-reason: |-
    When showing recent annotations per city, filter by originId rather than trying to match file paths to cities. Files store their originId ('local' or 'remote-hostname'), and cities have originId. Match on that field directly.

    Implementation: AnnotationPersistence.getRecentFiles(originId?, limit) filters annotations by originId if provided, groups by file, sorts by mostRecentAt.
---
