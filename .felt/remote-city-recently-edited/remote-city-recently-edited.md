---
title: Remote city Recently Edited files missing - needs SSH-based file polling
status: closed
tags:
    - '[hexarchy]'
created-at: 2026-01-25T17:02:36.286073+01:00
closed-at: 2026-01-25T21:49:40.534887+01:00
---

(remote-city-recently-edited)=
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
