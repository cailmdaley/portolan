---
title: 'Pattern: per-session transcript file tracking'
status: closed
depends-on:
    - bug-multiple-sessions-in-same
    - implement-transcriptreader-read
created-at: 2026-01-31T18:27:48.317282+01:00
closed-at: 2026-01-31T18:27:48.317288+01:00
---

(pattern-per-session-transcript)=
Multiple Claude sessions can run in the same project directory. Each creates its own transcript file (~/.claude/projects/{escaped-cwd}/{session-id}.jsonl). Need to track which transcript belongs to which tmux session.
