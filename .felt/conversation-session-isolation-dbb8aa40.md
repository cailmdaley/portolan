---
title: 'Conversation session isolation: sessionId before tmux aggregation'
status: closed
kind: decision
priority: 2
depends-on:
    - hook-based-conversation-capture-52030153
created-at: 2026-02-06T11:45:24.377201+01:00
closed-at: 2026-02-06T11:45:24.377204+01:00
close-reason: 'resolveConversationMessages was trying tmux aggregation FIRST, which pulled messages from all sessions sharing the same tmux name (e.g., multiple Claude sessions in ''chat''). Flipped priority: getMessages(sessionId) first, getMessagesByTmux as fallback only when session has no messages (restart case). Card also routes by sessionId now (preferred) with tmuxSession as fallback.'
---
