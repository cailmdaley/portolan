---
title: 'Conversation isolation: remove tmux fallback, add reconnect re-fetch'
tags:
    - '[portolan]'
depends-on:
    - conversation-session-isolation
    - conversationcard-tmux-match
created-at: 2026-02-13T00:45:08.015789+01:00
outcome: 'Removed tmux aggregation fallback from both server (resolveConversationMessages) and client (ConversationCard.handleMessage). Cards now match by sessionId only. Added refetchAllConversations() on WebSocket reconnect — all open cards re-fetch from server cache on ws.onopen. Fixes: after disconnect/reconnect, cards no longer show duplicate content from other sessions. Three files changed: ConversationCard.ts, ZoneRenderer.ts, main.ts, HttpApi.ts. getMessagesByTmux kept in ConversationCache but no longer called from resolution path.'
---

(conversation-isolation-remove)=
# Conversation isolation: remove tmux fallback, add reconnect re-fetch
