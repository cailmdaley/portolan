---
title: 'Plannotator: marketplace add vs plugin install'
status: closed
kind: question
priority: 2
created-at: 2026-01-19T02:37:39.249102+01:00
closed-at: 2026-01-19T02:37:48.320525+01:00
close-reason: 'Two separate steps: (1) /plugin marketplace add backnotprop/plannotator clones the repo, (2) /plugin install plannotator@plannotator activates the hooks. Without install step, hooks don''t fire. The hook reads JSON from stdin (tool_input.plan field) when ExitPlanMode triggers. If plannotator hangs or port in use, kill zombie processes on port 19473.'
---
