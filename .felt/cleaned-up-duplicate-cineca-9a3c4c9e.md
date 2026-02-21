---
title: Cleaned up duplicate cineca cmbx city entries
status: closed
kind: decision
priority: 2
created-at: 2026-02-11T03:15:07.820186+01:00
closed-at: 2026-02-11T03:15:07.820188+01:00
close-reason: 'cities.json had two cmbx entries: one from login05 (stale, from older agent) and one from login07 (current agent). Removed the login05 entry and updated the login07 entry''s sshHost from generic ''cineca'' to node-specific ''cineca-login07''. Also removed additionalDirectories from cmbx/.claude/settings.local.json (path was wrong anyway: /leonardo_work/EUHPC_E05_083/cmbx/inputs vs .../cdaley00/cmbx/inputs). Note: cineca SSH config has ''Host cineca cineca*'' pointing to login07-ext, so all cineca* aliases resolve to the same node — node-specific aliases are cosmetic but good practice for when the config changes.'
---
