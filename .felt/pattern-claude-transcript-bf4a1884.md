---
title: 'Pattern: Claude transcript correlation via cwd'
status: closed
kind: spec
priority: 2
depends-on:
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T03:22:28.378685+01:00
closed-at: 2026-01-31T03:22:28.378695+01:00
close-reason: 'Claude Code stores session transcripts at ~/.claude/projects/{escaped-cwd}/{session-id}.jsonl. The escaped-cwd replaces slashes with dashes (e.g., /Users/foo/bar → -Users-foo-bar). To get full conversation for a tmux session: (1) get cwd from tmux, (2) escape path, (3) find latest .jsonl in that directory, (4) parse JSON lines for type=user/assistant messages. Transcript contains thinking blocks, tool_use, assistant text. This unlocks conversation rendering without needing Claude Code hooks for assistant content.'
---
