---
title: Stop hook fires after assistant response written
status: closed
kind: question
priority: 2
depends-on:
    - hook-based-conversation-capture-52030153
created-at: 2026-02-03T04:12:10.200217+01:00
closed-at: 2026-02-03T04:12:10.200226+01:00
close-reason: 'Tested: when Stop hook runs, tail of transcript_path already contains assistant text block. Turn is complete and logged before hook executes. Safe to parse session log tail at Stop time to get full turn (thinking + text).'
---
