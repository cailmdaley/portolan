---
title: Stale agent on cineca
tags:
    - gotcha
depends-on:
    - stale-agent-deploy-541fa58f
created-at: 2026-03-30T11:11:43.770622+02:00
outcome: 'Deployed agent on cineca had old detectClaims checking results/claims (renamed to results/tapestry) and missing .felt/ check. Redeployed with scp. Also: killing the old tmux server process (portolan-agent) killed the cmbx session too — the tmux new-session -d process IS the server when there''s only one.'
---
