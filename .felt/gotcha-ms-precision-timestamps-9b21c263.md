---
title: 'Gotcha: ms-precision timestamps are NOT redundant — they distinguish content blocks'
status: closed
kind: decision
priority: 2
depends-on:
    - gotcha-timestamp-precision-37ef0ce9
created-at: 2026-02-06T11:45:33.50769+01:00
closed-at: 2026-02-06T11:45:33.507693+01:00
close-reason: 'ConversationCache was normalizing timestamps by stripping milliseconds (.123Z → Z). This collapsed thinking (23:59:09.389Z) and assistant text (23:59:09.545Z) from the same second into the same dedup key, silently dropping assistant text messages. Fix: use exact timestamps for dedup. Millisecond precision IS the distinguishing data. toolUseId handles cross-source dedup (PostToolUse vs Stop send the same tool call with different timestamps). Supersedes gotcha-timestamp-precision-37ef0ce9 which recommended normalization.'
---
