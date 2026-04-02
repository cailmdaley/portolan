---
title: Investigate intermittent missing recent files for remote workers in Portolan
status: closed
created-at: 2026-03-15T12:56:54.603655+01:00
closed-at: 2026-03-15T13:00:50.760486+01:00
outcome: Recent-file loss on remote Claude workers was not a tunnel failure but a worker-identity ambiguity. Remote PostToolUse hooks only sent Claude session UUID + cwd, so when multiple remote workers shared one project directory, /hook/file-touch guessed by cwd/lastActivity and could attach touches to the wrong worker. Fixed by making the remote portolan hook forward PostToolUse events with tmux_session and origin_name, teaching HttpApiHooksRuntime to resolve by origin-scoped tmux session before cwd heuristics, and updating install-remote to configure PostToolUse as the command hook instead of the bare HTTP hook. Verified with bash -n on both scripts and src/__tests__/HttpApi.file-touch.test.ts (7/7 passing), including a regression test for two remote workers sharing the same cwd.
---

(investigate-intermittent)=
## Comments
**2026-03-15 13:00** — Root cause appears to be remote PostToolUse hooks lacking tmux worker identity. When multiple remote Claude workers share one cwd, /hook/file-touch falls back to cwd/lastActivity and misattributes touches. Added remote hook enrichment (tmux_session + origin_name) and server-side exact resolution path.
**2026-03-15 13:08** — Rolled the fix out to candide with ./scripts/install-remote.sh candide. Remote ~/.claude/settings.json now has PostToolUse matcher Read|Write|Edit wired to /home/cdaley/.portolan/hooks/portolan-hook.sh, and the live tunnel probe from candide reached the local /hook/file-touch endpoint. The installer's original jq verification emitted a false negative on remote, so install-remote.sh was tightened to check PostToolUse command hooks with a simpler jq expression. Existing Claude sessions on candide still need restart to load the new hook config.
