---
title: Add index.ts WebSocket integration tests
status: closed
kind: task
tags:
    - ralph:3
priority: 2
depends-on:
    - server-14a1cdf1
created-at: 2026-01-18T00:42:22.158357+01:00
closed-at: 2026-01-18T00:45:28.257881+01:00
close-reason: 'Added integration tests for index.ts WebSocket server in src/__tests__/index.test.ts with 12 test cases covering: (1) WebSocket connection handling and initial state delivery, (2) Multiple concurrent client connections, (3) Focus message handling for non-existent sessions, (4) Malformed and missing data in messages, (5) Unknown message types, (6) Fiber count inclusion in state broadcasts, (7) State broadcasting to multiple clients, (8) Client disconnection and error recovery. Tests use mocked child_process and FiberReader to test real WebSocket communication without external dependencies. All 57 tests across 4 test files now pass. Documented limitations: cannot test actual Kitty focus commands or session change broadcasts without refactoring index.ts structure (which was intentionally avoided per task requirements).'
---
