---
title: 'Gotcha: subagent transcripts bleed into parent conversation via hook scan'
status: closed
kind: decision
priority: 2
created-at: 2026-02-07T17:49:54.573354+01:00
closed-at: 2026-02-07T17:50:01.725413+01:00
close-reason: 'Task tool subagents write to .../subagents/agent-<id>.jsonl under the parent session directory. Two leak paths: (1) UserPromptSubmit scan uses find *.jsonl which recurses into subagents/. (2) Subagent Stop hook fires with the subagent transcript_path but parent session_id, posting subagent content as parent conversation. Fix: exclude -not -path ''*/subagents/*'' in find, and case-match */subagents/* in Stop handler to skip.'
---
