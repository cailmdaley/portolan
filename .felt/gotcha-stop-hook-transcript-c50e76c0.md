---
title: 'Gotcha: Stop hook transcript race condition loses final assistant text'
status: closed
kind: decision
priority: 2
created-at: 2026-02-07T17:49:44.084312+01:00
closed-at: 2026-02-07T17:49:50.839625+01:00
close-reason: 'Stop hook fires before Claude Code finishes writing the final assistant text to the transcript JSONL. Both happen in the same sub-second — the hook''s tail|jq reads a stale snapshot missing the last entry. Fix: sleep 0.3 at the top of the Stop handler before reading the transcript. While the hook sleeps, Claude Code''s event loop flushes the pending write. 300ms is well beyond typical I/O latency.'
---
