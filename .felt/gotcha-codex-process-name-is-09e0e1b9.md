---
title: 'Gotcha: codex process name is ''node'' on Linux'
status: closed
tags:
    - portolan,gotcha
depends-on:
    - multi-cli-support-claude-codex-1be46415
created-at: 2026-02-20T01:32:22.136361+01:00
outcome: Codex CLI on Linux runs as 'node .../bin/codex' — ps -o comm= returns 'node', not 'codex'. Detection must check ps -o args= (full command line) as fallback after comm fails. On macOS the process name IS 'codex'. All three detection sites (SessionTracker, TranscriptReader, agent.js) now check both comm and args, plus children's args.
---
