---
title: ConversationCard tmux match accepts cross-session duplicates
tags:
    - decision
created-at: 2026-02-12T11:13:43.384323+01:00
outcome: 'Card''s handleMessage() accepted WebSocket messages matching by tmuxSession even when the card already had messages from its own sessionId. Old session''s Stop hook + new session''s UserPromptSubmit both deliver the same user prompt with different wall-clock timestamps, bypassing timestamp dedup. Fix: only fall back to tmux matching when card has no messages yet (conversation.length === 0), matching server-side resolveConversationMessages logic.'
---
