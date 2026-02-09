---
title: 'Pattern: Enter saves, Shift+Enter for newline in annotation inputs'
status: closed
kind: decision
priority: 2
depends-on:
    - claims-annotation-side-panel-f290eeb2
created-at: 2026-02-07T21:12:01.924786+01:00
closed-at: 2026-02-07T21:12:01.924791+01:00
close-reason: All annotation textareas (iframe popover + sidebar global feedback) use Enter to save and Shift+Enter for newline. Previously used Cmd+Enter to save. Enter-to-save is faster for short annotations (the common case). Shift+Enter for multi-line is the standard chat convention. Hint text updated to 'enter to save, shift+enter for newline'.
---
