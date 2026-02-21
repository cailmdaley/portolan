---
title: Lightbox escape handler cleanup on all close paths
status: closed
kind: decision
priority: 2
created-at: 2026-02-09T03:07:25.140383+01:00
closed-at: 2026-02-09T03:07:25.140386+01:00
close-reason: 'The lightbox keydown handler for Escape was only removed when Escape was pressed. Closing via close button, backdrop click, or image annotation left a dead listener attached to document. Fixed by defining escHandler before close(), removing listener inside close(), and adding it once unconditionally. Pattern: always clean up listeners in the close/dispose path, not the trigger path.'
---
