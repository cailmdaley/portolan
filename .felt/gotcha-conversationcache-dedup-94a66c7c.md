---
title: 'Gotcha: ConversationCache dedup must check within incoming batch'
status: closed
kind: decision
priority: 2
depends-on:
    - mid-turn-assistant-text-needs-3ab050e3
created-at: 2026-02-06T17:25:05.478279+01:00
closed-at: 2026-02-06T17:25:05.478282+01:00
close-reason: 'addMessages() was deduplicating incoming messages against the existing cache, but not against each other within the same batch. When PostToolUse sends both transcript-extracted tool_use blocks AND payload tool_use blocks in one POST, both pass dedup and create duplicates. Fix: accumulate seen timestamps/toolUseIds as each message in the batch is processed. Same issue existed in ConversationCard.handleMessage() client-side.'
---
