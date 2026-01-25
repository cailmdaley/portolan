---
title: Remote city Recently Edited files missing - needs SSH-based file polling
status: closed
kind: task
tags:
    - '[hexarchy]'
priority: 2
created-at: 2026-01-25T17:02:36.286073+01:00
closed-at: 2026-01-25T21:49:40.534887+01:00
close-reason: |-
    Implemented activity-based tracking for recently edited files.

    **Changes:**
    1. Added `recordActivityEdit()` method to RecentFilesManager (server/src/RecentFilesManager.ts)
       - Extracts relative path from fullPath
       - For local: updates in-memory cache and triggers update handler
       - For remote: calls `recordRemoteFileAccess()` which persists to ~/.hexarchy/recent-files.json

    2. Wired up activity tracking in index.ts:
       - Remote activities (agent_activity messages): When Edit/Write tools have fullPath, records to city
       - Local activities (eventWatcher.onActivity): Same logic for local sessions

    **How it works:**
    - Workers using Edit/Write tools emit activity events with fullPath
    - Server intercepts these and records them as recently edited
    - For remote cities, this persists across server restarts
    - For local cities, filesystem polling already catches edits, but activity tracking provides immediate updates

    **Note:** This is Option 2 from the fiber - tracking worker activity rather than SSH-based polling. External edits (not through tracked workers) won't appear, but worker-based edits will show immediately.
---

## Problem
Remote cities (like pure_eb on remote-c02) show "No recent files" in the CityPanel's "RECENTLY EDITED" section.

## Root Cause
`RecentFilesManager` uses local `find` and `stat` commands which don't work for remote paths like `/automnt/n17data/...`.

## Current Behavior
- For local cities: `recentFilesManager.getFiles(city.path)` returns files
- For remote cities: The path doesn't exist locally, so no files are returned

## Possible Solutions
1. **SSH-based polling**: Run find/stat commands over SSH for remote origins
2. **Activity-based tracking**: Use worker activity (Edits, Writes) to track recently touched files
3. **Remote file watcher**: Have the remote agent report file changes back

Option 2 is probably easiest - we already track worker activity and could extract file paths from Edit/Write tool uses.
