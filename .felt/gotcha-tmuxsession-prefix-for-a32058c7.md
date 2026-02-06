---
title: 'Gotcha: tmuxSession prefix for remote sessions'
status: closed
kind: spec
priority: 2
depends-on:
    - fix-remote-chat-updates-c688a85d
created-at: 2026-02-04T16:35:19.465772+01:00
closed-at: 2026-02-04T16:35:19.490009+01:00
close-reason: 'Server uses ''originId/tmuxSession'' (e.g., ''remote-c02/test'') in ConversationCache and WebSocket broadcasts. But Session objects from state have unprefixed tmuxSession (e.g., ''test''). Client-side code matching against WebSocket messages must build the prefixed key: `originId === ''local'' ? tmuxSession : \`${originId}/${tmuxSession}\``'
---
