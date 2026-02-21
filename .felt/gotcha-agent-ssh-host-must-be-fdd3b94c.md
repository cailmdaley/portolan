---
title: 'Gotcha: agent --ssh-host must be base name, not node-specific'
tags:
    - portolan, gotcha
depends-on:
    - ssh-stability-controlmaster-5e3ed591
created-at: 2026-02-15T15:57:29.601683+01:00
outcome: 'The activate endpoint in HttpApi.ts passes getSshHost() (which returns the node-specific host like cineca-login07) as --ssh-host= to the agent. But agent.js buildSpecificSshHost appends the login node from hostname. So --ssh-host=cineca-login07 becomes cineca-login07-login07. Fix: (1) made buildSpecificSshHost idempotent (skip if already ends with node suffix), (2) launch agent with base name --ssh-host=cineca. The activate endpoint at HttpApi.ts:945 still passes the specific host — should be fixed to pass base host, but the idempotency guard handles it now.'
---
