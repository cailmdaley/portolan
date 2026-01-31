---
title: 'Bug: multiple sessions in same cwd showed same transcript'
status: closed
kind: decision
priority: 2
created-at: 2026-01-31T18:27:41.267568+01:00
closed-at: 2026-01-31T18:27:41.267574+01:00
close-reason: 'TranscriptReader.findLatestTranscript() picked the most recently modified .jsonl file by cwd, but multiple Claude sessions can run in the same directory. Fixed by tracking session→transcript mapping: when activity is detected, detect which transcript was recently modified and associate it with that session ID. getRecentMessages() now accepts optional sessionId parameter to use the mapped transcript.'
---
