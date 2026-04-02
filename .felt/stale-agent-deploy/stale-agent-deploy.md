---
title: Stale agent deploy
depends-on:
    - agent-filters-portolan-agent
created-at: 2026-03-12T22:28:46.283206+01:00
outcome: 'Candide had old hexarchy-agent.js deployed — filtered tmuxSession \!== ''hexarchy-agent'' but session was named ''portolan-agent'', so it appeared as a flickering worker on the map. Redeployed current agent.js via scp. Also fixed HttpApiActivation.ts which had old path ~/bin/ instead of ~/.local/bin/. Symptom: portolan-agent bird flickering on map at regular cadence. Root cause: name mismatch in session filter on stale remote agent.'
---

(stale-agent-deploy)=
# Stale agent deploy
