---
title: Remote origin ID mismatch
tags:
    - gotcha
depends-on:
    - ssh-host-resolution-uses-raw-3507e967
created-at: 2026-03-30T11:11:32.765252+02:00
outcome: 'Agent''s raw hostname (login07.leonardo.local) produced origin ID remote-login07.leonardo.local, not matching persisted remote-cineca. Fixed in index.ts: derive origin name from sshHost param (cineca-login07 → cineca) instead of raw hostname. Same normalization already applied to persisted cities at startup, but was missing for runtime agent connections.'
---
