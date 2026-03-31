---
title: Debug pure EB worker flicker
status: closed
created-at: 2026-03-15T17:51:29.609851+01:00
closed-at: 2026-03-15T17:57:19.320455+01:00
outcome: Pure EB worker flicker was caused by two portolan-agent processes running on candide for the same origin. Their agent_sessions_update payloads raced and alternately overwrote remote-c02 with different worker sets, producing the observed 2↔5 oscillation and the intermittent {slide`, final_review} subset. Killed the stale older agent (PID 38404), which stabilized the live websocket state. Also patched OriginManager to enforce a single live agent socket per remote origin so future duplicate agents cannot coexist; restart the local portolan server to activate that guard.
---
