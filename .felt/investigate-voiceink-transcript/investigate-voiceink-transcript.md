---
title: Investigate VoiceInk transcript bridge for Portolan meeting assistant
status: closed
created-at: 2026-04-02T19:23:47.79061+02:00
closed-at: 2026-04-02T19:47:29.245796+02:00
outcome: VoiceInk is good enough for the first bridge. Completed transcript rows from its local SwiftData/SQLite store can be tailed and injected into a Portolan worker session; the remaining unresolved question is only whether to invest in true live partial streaming later.
---

(investigate-voiceink-transcript)=
Investigate whether VoiceInk can serve as the first transcript bridge into a Portolan meeting worker. Current findings: completed transcripts are stored in ~/Library/Application Support/com.prakashjoshipax.VoiceInk/default.store as SwiftData/SQLite rows; live partial transcript stays in VoiceInk process state and is not written incrementally. The easiest first bridge is polling newly completed transcript rows, not true streaming, unless we modify VoiceInk or scrape its live UI.
