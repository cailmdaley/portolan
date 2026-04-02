---
title: 'Persistent cities: auto-remember, click dormant remote to SSH + start agent'
status: closed
created-at: 2026-01-19T08:53:04.778016+01:00
closed-at: 2026-01-19T09:01:18.22452+01:00
---

(persistent-cities-auto-remember)=
## Design

**Current**: Cities ephemeral — exist only while sessions have that cwd.
**New**: Cities persist. Dormant cities (no active workers) still show on map.

### Storage
`~/.hexarchy/cities.json`:
```json
{
  "cities": [
    { "path": "/Users/.../hexarchy-v2", "host": "local", "name": "hexarchy-v2" },
    { "path": "/home/user/project", "host": "candide", "name": "project" }
  ]
}
```

### Behavior
1. **Auto-remember**: When a city is seen (via session or remote agent), persist it
2. **Visual state**: Dormant cities shown differently (muted hex color, no workers)
3. **Click dormant local**: Just shows panel (no workers to spawn)
4. **Click dormant remote**: SSH into host, start hexarchy-agent, workers appear
5. **Remove**: Right-click → 'Forget City'

### SSH Agent Start
```bash
ssh $host "tmux new-session -d -s hexarchy-agent 'node ~/bin/hexarchy-agent.js connect --ssh-host=$host'"
```

### Server Changes
- CityPersistence.ts: Load/save cities.json, merge with live session data
- Track city.status: 'active' (has workers) | 'dormant' (remembered, no workers)
- Add endpoint: POST /city/:id/activate → SSH + start agent

### Frontend Changes  
- Dormant cities: muted gold hex, show on map
- Click dormant remote → POST /city/:id/activate → wait for agent → workers appear
