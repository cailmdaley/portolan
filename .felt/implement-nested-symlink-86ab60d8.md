---
title: Implement nested+symlink filename search
status: closed
depends-on:
    - investigate-remote-nested-c3656174
    - search-tools-fd-rg-with-find-ee13e331
created-at: 2026-03-02T16:13:19.884505+01:00
closed-at: 2026-03-02T16:14:38.386938+01:00
outcome: 'Updated search in server/src/index.ts: filename mode now uses fd --follow --full-path (local + remote) and find -L fallback; content mode now follows symlinks via rg --follow and grep -R fallback. Verified with temp repro: query foo.py returned both bar/baz/foo.py and link/baz/foo.py.'
---
