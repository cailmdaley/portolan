---
title: 'Pattern: per-session transcript file tracking'
status: closed
kind: spec
priority: 2
depends-on:
    - bug-multiple-sessions-in-same-405a472f
    - implement-transcriptreader-read-001d1042
created-at: 2026-01-31T18:27:48.317282+01:00
closed-at: 2026-01-31T18:27:48.317288+01:00
close-reason: |-
    TranscriptReader now has:
    - sessionTranscriptMap: Map<sessionId, transcriptPath>
    - setSessionTranscript(sessionId, path): associate session with transcript
    - getSessionTranscript(sessionId): retrieve mapping
    - detectActiveTranscript(cwd, withinMs): find recently modified transcript
    - listTranscripts(cwd): list all transcripts sorted by mtime

    Detection happens in EventWatcher.onActivity callback when first activity arrives for a session.
---

Multiple Claude sessions can run in the same project directory. Each creates its own transcript file (~/.claude/projects/{escaped-cwd}/{session-id}.jsonl). Need to track which transcript belongs to which tmux session.
