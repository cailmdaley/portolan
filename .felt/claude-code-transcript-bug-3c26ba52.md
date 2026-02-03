---
title: 'Claude Code transcript bug: missing assistant text events'
status: closed
kind: question
priority: 2
depends-on:
    - hook-based-conversation-capture-52030153
created-at: 2026-02-03T04:12:10.196189+01:00
closed-at: 2026-02-03T04:12:10.196193+01:00
close-reason: 'Claude Code sometimes fails to write assistant text events to session log even though text displays in terminal. Observed in ''fun'' session: 5 of 8 assistant responses only had thinking blocks in transcript, no text. Terminal scrollback showed the text was generated. Upstream bug in Claude Code''s streaming transcript writer. Affects any tool reading transcripts.'
---
