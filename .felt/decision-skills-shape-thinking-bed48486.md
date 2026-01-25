---
title: 'Decision: Skills shape thinking, Tasks delegate doing'
status: closed
kind: decision
priority: 2
created-at: 2026-01-25T13:50:20.105752+01:00
closed-at: 2026-01-25T13:50:20.105755+01:00
close-reason: Skills are prompt injections — /implementing-code loads instructions that modify how Claude approaches work in the current conversation. Tasks spawn subagents with separate context that run autonomously and return summaries. Use skills when you need domain knowledge to inform judgment. Use tasks when you need to parallelize work or keep main context clean. code-simplifier is a Task subagent (good for polishing after changes), not a Skill.
---
