---
title: Worker hex positions were relative to origin, not city
status: closed
kind: task
priority: 2
depends-on:
    - wire-worker-hex-assignment-ecbd9bc5
created-at: 2026-01-18T02:57:22.173591+01:00
closed-at: 2026-01-18T02:57:22.173592+01:00
close-reason: 'Fixed in buildState(): workerHex is assigned relative to (0,0) by CityManager.assignWorkerHex(), but needs to be offset by city.position before sending to frontend. Workers from different cities were overlapping at origin. Fix: sessionsWithAbsoluteHex map that adds city.position.q/r to session.workerHex.q/r.'
---
