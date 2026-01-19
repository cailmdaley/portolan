---
title: Banner transparency not working - shows checkered background
status: closed
kind: task
priority: 2
created-at: 2026-01-18T18:11:04.868829+01:00
closed-at: 2026-01-18T18:33:53.674468+01:00
close-reason: Fixed via difference matting. Nano Banana can't output true transparency, so we generate on white, edit to black, then mathematically extract alpha by comparing how pixels appear on both backgrounds. Added scripts/extract_alpha.ts for the workflow. Threshold added to handle AI variation noise.
---
