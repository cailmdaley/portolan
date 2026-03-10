---
title: Harden file-touch path resolution and session cleanup
status: closed
tags:
    - portolan
depends-on:
    - constitution-http-hooks-file-c8cc25bf
created-at: 2026-03-02T04:08:28.117457+01:00
closed-at: 2026-03-02T04:08:32.516128+01:00
outcome: 'Hook ingestion now canonicalizes relative tool_input.file_path values with cwd before resolution/storage, preventing unresolved relative paths from missing session matches or opening invalid paths in tooltip flow. ZoneRenderer recent-file fetch now targets http://<window.location.hostname>:4004 for non-localhost browser access. recentFileTracker entries are removed when local/remote sessions are removed or remote origins disconnect, keeping in-memory trails bounded. Verified with server tests: npm test -- HttpApi.file-touch.test.ts index.test.ts (pass), root build: npm run build (pass), and curl POST /hook/file-touch returns success response on localhost:4004.'
---

Normalize relative PostToolUse file paths with cwd before session matching/storage, use browser hostname for tooltip fetch URL, and clear recent-file entries when sessions disappear to keep hover data bounded.
