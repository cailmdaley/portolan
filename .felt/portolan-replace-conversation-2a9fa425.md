---
title: 'Portolan: replace conversation pipeline with file-touch HTTP hooks'
status: closed
depends-on:
    - constitution-http-hooks-file-c8cc25bf
created-at: 2026-03-02T03:46:39.681748+01:00
closed-at: 2026-03-02T03:52:58.782057+01:00
outcome: 'Implemented server-side file-touch pipeline: added RecentFileTracker, replaced HttpApi conversation/card endpoints with POST /hook/file-touch + GET /recent-files, removed ConversationCache wiring in server/index, and added HttpApi.file-touch tests. Updated ~/.claude/settings.json PostToolUse to native HTTP hook matcher Read|Write|Edit and removed conversation hook entries from Stop/UserPromptSubmit. Remaining work is frontend descope: remove ConversationCard/ZoneRenderer card machinery, add bird hover tooltip + FileViewerModal wiring, and delete legacy conversation artifacts/tests/files.'
---
