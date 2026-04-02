---
title: Remove transcript debug plumbing from file-touch migration
status: closed
tags:
    - portolan
    - cleanup
depends-on:
    - coastline-file-touch-hover
created-at: 2026-03-02T04:27:53.084019+01:00
closed-at: 2026-03-02T04:27:56.875181+01:00
outcome: 'Removed transcript remnants from the server path used by file-touch hover: deleted server/src/TranscriptReader.ts, removed HttpApi transcript fields/setter plus /debug-transcripts route/handler, and removed transcript mapping logic from EventWatcher activity handling in index.ts. Updated stale conversation-related comments in EventWatcher and WorkerSwarm. Verification: rg shows no TranscriptReader/debug-transcripts refs in server/src; server build passes (npm --prefix server run build); full server test suite passes (npm --prefix server test, 248 tests).'
---

(remove-transcript-debug)=
Delete transcript debug endpoint and TranscriptReader wiring so file-touch hover no longer carries transcript-scanning remnants.
