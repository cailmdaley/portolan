---
title: Camera arrow keys skip focused inputs
status: closed
kind: decision
priority: 2
created-at: 2026-02-06T00:19:03.253667+01:00
closed-at: 2026-02-06T00:19:03.253671+01:00
close-reason: Arrow key camera panning now checks if event target is INPUT, TEXTAREA, or contentEditable before moving camera. Allows text editing in chat input and file viewer without camera drift.
---
