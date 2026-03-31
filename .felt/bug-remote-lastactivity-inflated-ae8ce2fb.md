---
title: 'Bug: remote lastActivity inflated'
status: closed
tags:
    - portolan
    - gotcha
created-at: 2026-03-14T15:45:58.601523+01:00
outcome: 'RemoteAgentCoordinator.reconcileSessions() set lastActivity = Date.now() unconditionally on every agent poll (line 144). This made all remote workers appear most recently active regardless of actual status. Fix: only bump lastActivity when status === ''working'', matching local worker semantics in EventWatcherSessionState.'
---
