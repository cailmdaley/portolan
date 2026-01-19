---
title: 'EventWatcher: byte vs character position bug'
status: closed
kind: decision
priority: 2
depends-on:
    - fireside-command-civ6-inspired-919b3ee0
created-at: 2026-01-19T03:14:40.508751+01:00
closed-at: 2026-01-19T03:20:50.133232+01:00
close-reason: 'Fixed: EventWatcher now tracks lastCharPosition (chars) not bytes. Uses content.slice(lastCharPosition) instead of fs.read with byte offset. Handles UTF-8 multi-byte chars correctly.'
---
