---
title: Harden ConversationCard async lifecycle and teardown ownership
status: closed
tags:
    - task
depends-on:
    - constitution-portolan-da3b0f59
created-at: 2026-03-01T16:55:47.827401+01:00
closed-at: 2026-03-01T16:57:19.399296+01:00
outcome: 'Hardened ConversationCard async ownership in src/ui/ConversationCard.ts: fetchConversation now uses AbortController + monotonic request IDs + owned timeout cancellation so stale/superseded/disposed requests cannot mutate current UI state; sendMessage now uses owned AbortController and guarded placeholder reset timeout; dispose now deterministically aborts in-flight send/fetch operations and clears all owned timers before DOM teardown. Evidence: npm run build passed; cd server && npm test && npm run build passed (239 tests).'
---
