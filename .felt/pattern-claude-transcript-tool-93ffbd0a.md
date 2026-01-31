---
title: 'Pattern: Claude transcript tool_result parsing'
status: closed
kind: spec
priority: 2
depends-on:
    - pattern-claude-transcript-bf4a1884
    - conversation-activity-feed-show-51b2ad20
created-at: 2026-01-31T06:03:00.927374+01:00
closed-at: 2026-01-31T06:03:00.927378+01:00
close-reason: 'In Claude Code transcripts (~/.claude/projects/{cwd}/{session}.jsonl), tool_result blocks appear within ''user'' type events, not as separate events. They''re embedded in message.content as array blocks with type=''tool_result'', tool_use_id, and content fields. Content can be string or array of {type:''text'', text:...}. To parse: check event.type===''user'', then iterate event.message.content looking for block.type===''tool_result''. Link via tool_use_id to corresponding tool_use block.'
---
