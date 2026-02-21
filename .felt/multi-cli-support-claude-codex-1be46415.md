---
title: 'Multi-CLI support: Claude + Codex coexistence'
status: closed
tags:
    - portolan
created-at: 2026-02-20T01:32:11.339794+01:00
outcome: Portolan now detects and launches both Claude and Codex workers simultaneously. cli-provider.ts exports providers map + getProvider(name) helper. Session interface has cli field. NewWorkerDialog has CLI selector (Claude default). Detection uses both ps comm and ps args (codex on Linux runs as 'node .../bin/codex'). Agent.js detects both CLIs regardless of env var.
---
