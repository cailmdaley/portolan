---
title: 'Decision: claim annotations use existing send-to-worker, not hook injection'
status: closed
kind: decision
priority: 2
created-at: 2026-02-07T03:09:20.714278+01:00
closed-at: 2026-02-07T03:09:20.714281+01:00
close-reason: 'Considered hook-based approach (UserPromptSubmit reads queue, injects into prompt). Rejected: existing send-to-worker pattern (tmux load-buffer + paste-buffer, no Enter) already works, supports batching across multiple review items, is proven infrastructure. No new mechanisms needed. Same POST /send-annotations endpoint with claims-specific format.'
---
